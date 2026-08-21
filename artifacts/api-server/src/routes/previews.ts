import { and, count, eq, gt, lt, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  clientPreviewsTable,
  db,
  previewRateLimitsTable,
} from "@workspace/db";
import {
  PublishPreviewBody,
  PublishPreviewHeader,
  PublishPreviewResponse,
  RefreshPreviewBody,
  RefreshPreviewHeader,
  RefreshPreviewParams,
  RefreshPreviewResponse,
  RevokePreviewHeader,
  RevokePreviewParams,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  PROSPECT_EDITOR_HASH_PREFIX,
  allowedPageNames,
  hashSecret,
  newSecret,
  previewLifetimeMs,
  serveStoredPreviewAsset,
  validateSite,
} from "../lib/preview-store";

// Re-export the shared preview-store surface so existing importers of
// "../previews" continue to resolve these unchanged. The pure validation and
// stored-site response logic now lives in ../lib/preview-store.
export {
  PROSPECT_EDITOR_HASH_PREFIX,
  allowedPageNames,
  hashSecret,
  newSecret,
  previewLifetimeMs,
  serveStoredPreviewAsset,
  validateSite,
};

const router: IRouter = Router();
const publishWindowMs = 60 * 60 * 1000;
const maxPublishesPerIp = 20;
const maxActivePreviewsPerEditor = 10;
const maxActivePreviews = 200;
const publishLockId = 7_414_107;

/** SQL predicate matching only ordinary (non-prospect) client_previews rows. */
const ordinaryPreviewsFilter = sql`${clientPreviewsTable.editorHash} NOT LIKE ${
  PROSPECT_EDITOR_HASH_PREFIX + "%"
}`;

const cleanupTimer = setInterval(() => {
  void Promise.all([
    db
      .delete(clientPreviewsTable)
      .where(lt(clientPreviewsTable.expiresAt, new Date())),
    db
      .delete(previewRateLimitsTable)
      .where(
        lt(
          previewRateLimitsTable.windowStartedAt,
          new Date(Date.now() - 2 * publishWindowMs),
        ),
      ),
  ])
    .catch((error: unknown) => {
      logger.warn({ error }, "Failed to clean up preview service records");
    });
}, 10 * 60 * 1000);
cleanupTimer.unref();

class PublishLimitError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly clientMessage: string,
  ) {
    super(clientMessage);
  }
}

function publication(
  previewId: string,
  token: string,
  expiresAt: Date,
  projectUpdatedAt: number,
) {
  return {
    previewId,
    path: `/api/previews/public/${token}/`,
    expiresAt,
    projectUpdatedAt,
  };
}

function getParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function getEditorHeader(req: Request): Record<string, string | undefined> {
  return {
    "X-SiteForge-Editor-Key": req.get("X-SiteForge-Editor-Key"),
  };
}

async function consumePublishQuota(req: Request): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - publishWindowMs);
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const keyHash = hashSecret(`publish:${ip}`);
  const [entry] = await db
    .insert(previewRateLimitsTable)
    .values({
      keyHash,
      windowStartedAt: now,
      requestCount: 1,
    })
    .onConflictDoUpdate({
      target: previewRateLimitsTable.keyHash,
      set: {
        requestCount: sql`
          CASE
            WHEN ${previewRateLimitsTable.windowStartedAt} <= ${cutoff} THEN 1
            ELSE ${previewRateLimitsTable.requestCount} + 1
          END
        `,
        windowStartedAt: sql`
          CASE
            WHEN ${previewRateLimitsTable.windowStartedAt} <= ${cutoff} THEN ${now}
            ELSE ${previewRateLimitsTable.windowStartedAt}
          END
        `,
      },
    })
    .returning({ requestCount: previewRateLimitsTable.requestCount });

  return entry.requestCount <= maxPublishesPerIp;
}

async function sendPublicAsset(req: Request, res: Response): Promise<void> {
  const tokenHash = hashSecret(getParam(req, "token"));
  const [preview] = await db
    .select()
    .from(clientPreviewsTable)
    .where(
      and(
        eq(clientPreviewsTable.tokenHash, tokenHash),
        gt(clientPreviewsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!preview) {
    res.status(404).type("text/plain").send("This preview is unavailable.");
    return;
  }

  const requestedAsset = getParam(req, "asset") || "index.html";
  serveStoredPreviewAsset(res, preview.site, requestedAsset);
}

router.get("/previews/public/:token", sendPublicAsset);
router.get("/previews/public/:token/assets/:asset", sendPublicAsset);
router.get("/previews/public/:token/:asset", sendPublicAsset);

router.post("/previews", async (req, res): Promise<void> => {
  const header = PublishPreviewHeader.safeParse(getEditorHeader(req));
  const body = PublishPreviewBody.safeParse(req.body);
  if (!header.success || !body.success) {
    req.log.warn("Invalid preview publish request");
    res.status(400).json({ error: "The preview data is invalid." });
    return;
  }
  if (!Number.isSafeInteger(body.data.projectUpdatedAt)) {
    res.status(400).json({ error: "The project revision is invalid." });
    return;
  }

  const validationError = validateSite(body.data.site);
  if (validationError) {
    req.log.warn({ validationError }, "Rejected unsafe preview");
    res.status(400).json({ error: validationError });
    return;
  }
  if (!(await consumePublishQuota(req))) {
    res.status(429).json({ error: "Too many previews published. Try again later." });
    return;
  }

  const editorHash = hashSecret(header.data["X-SiteForge-Editor-Key"]);
  const previewId = newSecret();
  const token = newSecret();
  const expiresAt = new Date(Date.now() + previewLifetimeMs);

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${publishLockId})`);
      await tx
        .delete(clientPreviewsTable)
        .where(lt(clientPreviewsTable.expiresAt, new Date()));

      const existing = await tx
        .select({ idHash: clientPreviewsTable.idHash })
        .from(clientPreviewsTable)
        .where(
          and(
            eq(clientPreviewsTable.editorHash, editorHash),
            eq(clientPreviewsTable.projectId, body.data.projectId),
          ),
        )
        .limit(1);
      // Prospect-internal rows live in a reserved editorHash namespace and must
      // not consume ordinary per-editor or total capacity.
      const editorCount = await tx
        .select({ value: count() })
        .from(clientPreviewsTable)
        .where(
          and(
            eq(clientPreviewsTable.editorHash, editorHash),
            ordinaryPreviewsFilter,
          ),
        );
      const totalCount = await tx
        .select({ value: count() })
        .from(clientPreviewsTable)
        .where(ordinaryPreviewsFilter);

      if (!existing[0] && editorCount[0].value >= maxActivePreviewsPerEditor) {
        throw new PublishLimitError(
          429,
          "This Studio has reached its active preview limit.",
        );
      }
      if (!existing[0] && totalCount[0].value >= maxActivePreviews) {
        throw new PublishLimitError(503, "Preview capacity is temporarily full.");
      }

      await tx
        .delete(clientPreviewsTable)
        .where(
          and(
            eq(clientPreviewsTable.editorHash, editorHash),
            eq(clientPreviewsTable.projectId, body.data.projectId),
          ),
        );
      await tx.insert(clientPreviewsTable).values({
        idHash: hashSecret(previewId),
        tokenHash: hashSecret(token),
        editorHash,
        projectId: body.data.projectId,
        projectUpdatedAt: body.data.projectUpdatedAt,
        site: body.data.site,
        expiresAt,
      });
    });
  } catch (error) {
    if (error instanceof PublishLimitError) {
      res.status(error.status).json({ error: error.clientMessage });
      return;
    }
    throw error;
  }

  res
    .status(201)
    .json(
      PublishPreviewResponse.parse(
        publication(previewId, token, expiresAt, body.data.projectUpdatedAt),
      ),
    );
});

router.post("/previews/:previewId/refresh", async (req, res): Promise<void> => {
  const params = RefreshPreviewParams.safeParse(req.params);
  const header = RefreshPreviewHeader.safeParse(getEditorHeader(req));
  const body = RefreshPreviewBody.safeParse(req.body);
  if (!params.success || !header.success || !body.success) {
    res.status(400).json({ error: "The preview data is invalid." });
    return;
  }
  if (!Number.isSafeInteger(body.data.projectUpdatedAt)) {
    res.status(400).json({ error: "The project revision is invalid." });
    return;
  }

  const validationError = validateSite(body.data.site);
  if (validationError) {
    req.log.warn({ validationError }, "Rejected unsafe preview refresh");
    res.status(400).json({ error: validationError });
    return;
  }

  const token = newSecret();
  const expiresAt = new Date(Date.now() + previewLifetimeMs);
  const [updated] = await db
    .update(clientPreviewsTable)
    .set({
      tokenHash: hashSecret(token),
      site: body.data.site,
      projectUpdatedAt: body.data.projectUpdatedAt,
      expiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(clientPreviewsTable.idHash, hashSecret(params.data.previewId)),
        eq(
          clientPreviewsTable.editorHash,
          hashSecret(header.data["X-SiteForge-Editor-Key"]),
        ),
        gt(clientPreviewsTable.expiresAt, new Date()),
      ),
    )
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Preview not found." });
    return;
  }

  res.json(
    RefreshPreviewResponse.parse(
      publication(
        params.data.previewId,
        token,
        expiresAt,
        body.data.projectUpdatedAt,
      ),
    ),
  );
});

router.delete("/previews/:previewId", async (req, res): Promise<void> => {
  const params = RevokePreviewParams.safeParse(req.params);
  const header = RevokePreviewHeader.safeParse(getEditorHeader(req));
  if (!params.success || !header.success) {
    res.status(400).json({ error: "Invalid preview identifier." });
    return;
  }

  const removed = await db
    .delete(clientPreviewsTable)
    .where(
      and(
        eq(clientPreviewsTable.idHash, hashSecret(params.data.previewId)),
        eq(
          clientPreviewsTable.editorHash,
          hashSecret(header.data["X-SiteForge-Editor-Key"]),
        ),
      ),
    )
    .returning({ idHash: clientPreviewsTable.idHash });

  if (removed.length === 0) {
    res.status(404).json({ error: "Preview not found." });
    return;
  }

  res.sendStatus(204);
});

export default router;
