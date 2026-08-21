import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { db, siteforgeWebsitesTable, siteforgeUsersTable } from "@workspace/db";
import {
  GetWebsiteParams,
  GetWebsiteResponse,
  ListWebsitesResponse,
  CreateWebsiteBody,
  CreateWebsiteResponse,
  SaveWebsiteParams,
  SaveWebsiteBody,
  SaveWebsiteResponse,
  RenameWebsiteParams,
  RenameWebsiteBody,
  RenameWebsiteResponse,
  DeleteWebsiteParams,
  DuplicateWebsiteParams,
  DuplicateWebsiteBody,
  DuplicateWebsiteResponse,
  ImportWebsitesBody,
  ImportWebsitesResponse,
  GetAccountResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../../middlewares/requireAuth";
import { sanitizeProjectSource, stripCredentials } from "../../lib/website-sanitize";

const router: IRouter = Router();

function newWebsiteId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Serialize a DB row to a safe WebsiteRecord response.
 * Never includes ownerId (server-owned) or any credential fields.
 */
function serializeWebsite(row: typeof siteforgeWebsitesTable.$inferSelect) {
  return {
    id: row.id,
    // ownerId deliberately omitted — server-owned field, not exposed
    name: row.name,
    status: row.status,
    siteType: row.siteType as "customer" | "prospect",
    revision: row.revision,
    schemaVersion: row.schemaVersion,
    sourceUpdatedAt: row.sourceUpdatedAt ?? null,
    projectSource: stripCredentials(row.projectSource as Record<string, unknown>),
    settings: stripCredentials((row.settings ?? {}) as Record<string, unknown>),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isSafeNonNegativeInteger(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

// GET /account
router.get("/account", requireAuth, async (req, res): Promise<void> => {
  const userId = req.sfUserId!;
  const [user] = await db
    .select()
    .from(siteforgeUsersTable)
    .where(eq(siteforgeUsersTable.id, userId))
    .limit(1);

  if (!user) {
    res.status(404).json({ error: "Account not found." });
    return;
  }

  res.json(
    GetAccountResponse.parse({
      userId: user.id,
      email: user.email ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }),
  );
});

// GET /websites
router.get("/websites", requireAuth, async (req, res): Promise<void> => {
  const userId = req.sfUserId!;

  const websites = await db
    .select()
    .from(siteforgeWebsitesTable)
    .where(eq(siteforgeWebsitesTable.ownerId, userId))
    .orderBy(desc(siteforgeWebsitesTable.updatedAt));

  res.json(
    ListWebsitesResponse.parse({
      websites: websites.map(serializeWebsite),
    }),
  );
});

// POST /websites
router.post("/websites", requireAuth, async (req, res): Promise<void> => {
  const userId = req.sfUserId!;

  const body = CreateWebsiteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = body.data.id ?? newWebsiteId();
  const sanitized = sanitizeProjectSource(body.data.projectSource);
  delete sanitized.prospectMeta;

  // Validate safe integer values
  const projectSource = body.data.projectSource as Record<string, unknown>;
  if (
    projectSource.createdAt !== undefined &&
    !isSafeNonNegativeInteger(projectSource.createdAt)
  ) {
    res.status(400).json({ error: "projectSource.createdAt must be a safe non-negative integer." });
    return;
  }
  if (
    projectSource.updatedAt !== undefined &&
    !isSafeNonNegativeInteger(projectSource.updatedAt)
  ) {
    res.status(400).json({ error: "projectSource.updatedAt must be a safe non-negative integer." });
    return;
  }

  let website: typeof siteforgeWebsitesTable.$inferSelect | undefined;
  try {
    const [inserted] = await db
      .insert(siteforgeWebsitesTable)
      .values({
        ownerId: userId,
        id,
        name: body.data.name,
        projectSource: sanitized,
        settings: stripCredentials((body.data.settings ?? {}) as Record<string, unknown>),
        revision: 0,
        schemaVersion: 1,
      })
      .returning();
    website = inserted;
  } catch (err: unknown) {
    // Postgres unique violation (23505) = duplicate (ownerId, id)
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      res.status(409).json({ error: "A website with this ID already exists for your account." });
      return;
    }
    throw err;
  }

  if (!website) {
    res.status(500).json({ error: "Failed to create website." });
    return;
  }

  res.status(201).json(CreateWebsiteResponse.parse(serializeWebsite(website)));
});

/**
 * Import helper — extracted for testability.
 * Returns "imported" (new) or "skipped" (already exists). Never overwrites.
 */
export async function importWebsiteItem(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  item: {
    id: string;
    name: string;
    projectSource: Record<string, unknown>;
    settings?: Record<string, unknown>;
    sourceUpdatedAt?: number | null;
  },
): Promise<"imported" | "skipped"> {
  const sanitized = sanitizeProjectSource(item.projectSource);
  delete sanitized.prospectMeta;

  const existing = await tx
    .select({ id: siteforgeWebsitesTable.id })
    .from(siteforgeWebsitesTable)
    .where(
      and(
        eq(siteforgeWebsitesTable.ownerId, userId),
        eq(siteforgeWebsitesTable.id, item.id),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return "skipped";
  }

  await tx.insert(siteforgeWebsitesTable).values({
    ownerId: userId,
    id: item.id,
    name: item.name,
    projectSource: sanitized,
    settings: stripCredentials((item.settings ?? {}) as Record<string, unknown>),
    revision: 0,
    schemaVersion: 1,
    sourceUpdatedAt: item.sourceUpdatedAt ?? null,
  });

  return "imported";
}

// POST /websites/import  (must be before /:websiteId)
router.post("/websites/import", requireAuth, async (req, res): Promise<void> => {
  const userId = req.sfUserId!;

  const body = ImportWebsitesBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const items = body.data.websites;
  if (!items || items.length === 0 || items.length > 50) {
    res.status(400).json({ error: "websites must be an array with 1–50 items." });
    return;
  }

  const results: Array<{
    id: string;
    status: "imported" | "skipped";
    error: null;
  }> = [];
  let imported = 0;
  let skipped = 0;

  // All-or-nothing transaction: any DB error aborts everything
  await db.transaction(async (tx) => {
    for (const item of items) {
      const status = await importWebsiteItem(
        tx,
        userId,
        item as {
          id: string;
          name: string;
          projectSource: Record<string, unknown>;
          settings?: Record<string, unknown>;
          sourceUpdatedAt?: number | null;
        },
      );
      results.push({ id: item.id, status, error: null });
      if (status === "imported") imported++;
      else skipped++;
    }
  });

  res.json(
    ImportWebsitesResponse.parse({
      results,
      imported,
      updated: 0,
      skipped,
      errors: 0,
    }),
  );
});

// GET /websites/:websiteId
router.get("/websites/:websiteId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.sfUserId!;

  const params = GetWebsiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [website] = await db
    .select()
    .from(siteforgeWebsitesTable)
    .where(
      and(
        eq(siteforgeWebsitesTable.ownerId, userId),
        eq(siteforgeWebsitesTable.id, params.data.websiteId),
      ),
    )
    .limit(1);

  if (!website) {
    res.status(404).json({ error: "Website not found." });
    return;
  }

  res.json(GetWebsiteResponse.parse(serializeWebsite(website)));
});

// PUT /websites/:websiteId — full save with expectedRevision
router.put("/websites/:websiteId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.sfUserId!;

  const params = SaveWebsiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = SaveWebsiteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  // Safe integer checks
  if (!isSafeNonNegativeInteger(body.data.expectedRevision)) {
    res.status(400).json({ error: "expectedRevision must be a safe non-negative integer." });
    return;
  }
  if (
    body.data.sourceUpdatedAt !== undefined &&
    body.data.sourceUpdatedAt !== null &&
    !isSafeNonNegativeInteger(body.data.sourceUpdatedAt)
  ) {
    res.status(400).json({ error: "sourceUpdatedAt must be a safe non-negative integer." });
    return;
  }

  const sanitized = sanitizeProjectSource(body.data.projectSource);

  const result = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(siteforgeWebsitesTable)
      .where(
        and(
          eq(siteforgeWebsitesTable.ownerId, userId),
          eq(siteforgeWebsitesTable.id, params.data.websiteId),
        ),
      )
      .limit(1)
      .for("update");

    if (!current) return { kind: "not_found" } as const;

    if (current.revision !== body.data.expectedRevision) {
      return { kind: "conflict", current } as const;
    }

    const nextProjectSource = { ...sanitized };
    if (current.siteType === "prospect") {
      const storedProspectMeta = (
        current.projectSource as Record<string, unknown>
      ).prospectMeta;
      if (!storedProspectMeta || typeof storedProspectMeta !== "object") {
        return { kind: "invalid_prospect", current } as const;
      }
      nextProjectSource.prospectMeta = storedProspectMeta;
    } else {
      delete nextProjectSource.prospectMeta;
    }

    const [updated] = await tx
      .update(siteforgeWebsitesTable)
      .set({
        name: body.data.name ?? current.name,
        projectSource: nextProjectSource,
        settings: stripCredentials((body.data.settings ?? current.settings) as Record<string, unknown>),
        sourceUpdatedAt:
          body.data.sourceUpdatedAt !== undefined
            ? body.data.sourceUpdatedAt
            : current.sourceUpdatedAt,
        revision: current.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteforgeWebsitesTable.ownerId, userId),
          eq(siteforgeWebsitesTable.id, params.data.websiteId),
        ),
      )
      .returning();

    if (!updated) return { kind: "not_found" } as const;
    return { kind: "updated", website: updated } as const;
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Website not found." });
    return;
  }

  if (result.kind === "invalid_prospect") {
    res.status(409).json({
      error: "Prospect draft metadata is missing. Regenerate the prospect site from the lead workspace.",
    });
    return;
  }

  if (result.kind === "conflict") {
    res.status(409).json({
      error: "Stale revision. Fetch the current version and retry.",
      current: serializeWebsite(result.current),
    });
    return;
  }

  res.json(SaveWebsiteResponse.parse(serializeWebsite(result.website)));
});

// PATCH /websites/:websiteId — atomic rename with optimistic concurrency
// Updates BOTH the canonical row name AND projectSource.name atomically.
// Requires expectedRevision so a concurrent stale full-save cannot silently
// clobber a rename (or vice-versa).
router.patch("/websites/:websiteId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.sfUserId!;

  const params = RenameWebsiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = RenameWebsiteBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  if (!isSafeNonNegativeInteger(body.data.expectedRevision)) {
    res.status(400).json({ error: "expectedRevision must be a safe non-negative integer." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    // Acquire row lock for the duration of the transaction
    const [current] = await tx
      .select()
      .from(siteforgeWebsitesTable)
      .where(
        and(
          eq(siteforgeWebsitesTable.ownerId, userId),
          eq(siteforgeWebsitesTable.id, params.data.websiteId),
        ),
      )
      .limit(1)
      .for("update");

    if (!current) return { kind: "not_found" } as const;

    if (current.revision !== body.data.expectedRevision) {
      return { kind: "conflict", current } as const;
    }

    // Update the canonical row name AND synchronise projectSource.name
    // so both representations stay consistent. Also increment revision
    // so any concurrent stale full-save will see the revision mismatch.
    const existingSource = (current.projectSource ?? {}) as Record<string, unknown>;
    const updatedSource = { ...existingSource, name: body.data.name };

    const [updated] = await tx
      .update(siteforgeWebsitesTable)
      .set({
        name: body.data.name,
        projectSource: updatedSource,
        revision: current.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(siteforgeWebsitesTable.ownerId, userId),
          eq(siteforgeWebsitesTable.id, params.data.websiteId),
        ),
      )
      .returning();

    if (!updated) return { kind: "not_found" } as const;
    return { kind: "updated", website: updated } as const;
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Website not found." });
    return;
  }

  if (result.kind === "conflict") {
    res.status(409).json({
      error: "Stale revision. Fetch the current version and retry.",
      current: serializeWebsite(result.current),
    });
    return;
  }

  res.json(RenameWebsiteResponse.parse(serializeWebsite(result.website)));
});

// DELETE /websites/:websiteId
router.delete("/websites/:websiteId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.sfUserId!;

  const params = DeleteWebsiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [website] = await db
    .select({
      id: siteforgeWebsitesTable.id,
      siteType: siteforgeWebsitesTable.siteType,
    })
    .from(siteforgeWebsitesTable)
    .where(
      and(
        eq(siteforgeWebsitesTable.ownerId, userId),
        eq(siteforgeWebsitesTable.id, params.data.websiteId),
      ),
    )
    .limit(1);

  if (!website) {
    res.status(404).json({ error: "Website not found." });
    return;
  }

  if (website.siteType === "prospect") {
    res.status(409).json({
      error: "Prospect drafts must be archived from the lead workspace.",
    });
    return;
  }

  await db
    .delete(siteforgeWebsitesTable)
    .where(
      and(
        eq(siteforgeWebsitesTable.ownerId, userId),
        eq(siteforgeWebsitesTable.id, params.data.websiteId),
        eq(siteforgeWebsitesTable.siteType, "customer"),
      ),
    );

  res.status(204).end();
});

// POST /websites/:websiteId/duplicate
router.post(
  "/websites/:websiteId/duplicate",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.sfUserId!;

    const params = DuplicateWebsiteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const body = DuplicateWebsiteBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const [source] = await db
      .select()
      .from(siteforgeWebsitesTable)
      .where(
        and(
          eq(siteforgeWebsitesTable.ownerId, userId),
          eq(siteforgeWebsitesTable.id, params.data.websiteId),
        ),
      )
      .limit(1);

    if (!source) {
      res.status(404).json({ error: "Website not found." });
      return;
    }

    if (source.siteType === "prospect") {
      res.status(409).json({
        error: "Prospect drafts cannot be duplicated. Convert the lead to a customer first.",
      });
      return;
    }

    // Strip credentials (including ownerKey) from duplicated project; always new server ID.
    // Overlay BOTH id and name onto the copied projectSource so it references the new
    // website record, not the source. Without this, projectSource.id stays as the source
    // ID (causing duplicate React keys) and projectSource.name keeps the source name.
    // The original source row is never mutated — we only build a new object here.
    const newId = newWebsiteId();
    const sanitized: Record<string, unknown> = {
      ...sanitizeProjectSource(source.projectSource as Record<string, unknown>),
      id: newId,
      name: body.data.name,
    };
    delete sanitized.prospectMeta;

    const [duplicate] = await db
      .insert(siteforgeWebsitesTable)
      .values({
        ownerId: userId,
        id: newId,
        name: body.data.name,
        projectSource: sanitized,
        settings: stripCredentials((source.settings ?? {}) as Record<string, unknown>),
        revision: 0,
        schemaVersion: source.schemaVersion,
        sourceUpdatedAt: source.sourceUpdatedAt,
      })
      .returning();

    if (!duplicate) {
      res.status(500).json({ error: "Failed to duplicate website." });
      return;
    }

    res.status(201).json(
      DuplicateWebsiteResponse.parse(serializeWebsite(duplicate)),
    );
  },
);

export default router;
