/**
 * Prospect site lifecycle routes.
 *
 * GET    /leads/:leadId/prospect-site          — get lifecycle (200+null if none)
 * POST   /leads/:leadId/prospect-site          — generate (lead must be qualified)
 * POST   /leads/:leadId/prospect-site/regenerate
 * POST   /leads/:leadId/prospect-site/preview  — publish signed preview
 * DELETE /leads/:leadId/prospect-site/preview  — revoke preview
 * POST   /leads/:leadId/prospect-site/archive
 * POST   /leads/:leadId/prospect-site/convert
 *
 * ## Ownership and locking
 * - `ownerId` is always derived from `req.sfUserId` (set by requireAuth).
 * - Every mutating operation uses a DB transaction that SELECT FOR UPDATE
 *   locks the lifecycle row to prevent concurrent mutations.
 * - Generation/regeneration also lock the lead row.
 * - DELETE preview uses the same advisory lock + transaction as other mutations.
 *
 * ## Prospect-safe generation
 * - Lead must be qualified (pipelineStatus === 'qualified') and not suppressed.
 * - verifiedFields selects which lead fields to include; values come from
 *   the lead row, never from the client request body.
 * - businessName is required in verifiedFields.
 *
 * ## Provenance
 * - generate/regenerate append field-level provenance rows with
 *   provenance='verified' for each selected non-empty stored field.
 *   Values come from the current DB lead row; never client values.
 *
 * ## Lifecycle correctness
 * - Generate: conflicts if ANY lifecycle exists (unique constraint on leadId+ownerId).
 * - Regenerate: works for archived (restores to active_draft, creates fresh site)
 *   and active_draft (archives old website, supersedes old generation).
 *   Converted is terminal and always rejects.
 *   archivedAt is cleared on successful regenerate.
 * - Archive: increments website revision to conflict stale Studio saves.
 * - Convert: removes/clears stale prospectMeta draft metadata from projectSource
 *   while preserving all editable content/id, then increments revision.
 *   websiteId is kept on converted lifecycle for traceability.
 */

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  leadsTable,
  leadSourcesTable,
  siteforgeWebsitesTable,
  prospectSitesTable,
  prospectGenerationsTable,
  prospectPreviewsTable,
  clientPreviewsTable,
  type StoredGeneratedSite,
} from "@workspace/db";
import {
  GetProspectSiteParams,
  GetProspectSiteResponse,
  GenerateProspectSiteParams,
  GenerateProspectSiteBody,
  GenerateProspectSiteResponse,
  RegenerateProspectSiteParams,
  RegenerateProspectSiteBody,
  RegenerateProspectSiteResponse,
  PublishProspectPreviewParams,
  PublishProspectPreviewBody,
  PublishProspectPreviewResponse,
  RevokeProspectPreviewParams,
  ArchiveProspectSiteParams,
  ArchiveProspectSiteResponse,
  ConvertProspectSiteParams,
  ConvertProspectSiteBody,
  ConvertProspectSiteResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../../middlewares/requireAuth";
import { requireFeatureEnabled, newId } from "./helpers";
import { appendActivity } from "./lead-ops";
import {
  generateProspectProject,
  buildVerifiedFieldsSnapshot,
  validateProspectSafeProject,
  PROSPECT_ALLOWED_FIELDS,
} from "../../lib/prospect-generator";
import {
  templateFromCategory,
  isValidTemplateId,
} from "../../lib/prospect-category-map";
import {
  newMappingId,
  computeSignature,
  hashSignature,
  buildPreviewPath,
  previewExpiresAt,
} from "../../lib/prospect-preview-signing";
import {
  hashSecret,
  newSecret,
  validateSite,
  previewLifetimeMs,
  PROSPECT_EDITOR_HASH_PREFIX,
} from "../../lib/preview-store";
import { generateSite } from "@workspace/siteforge-core";
import type { SiteProject, TemplateId } from "@workspace/siteforge-core";
import { sanitizeProjectSource } from "../../lib/website-sanitize";
import { withLeadMutationLock } from "../../lib/lead-mutation-lock";
import type { Lead, ProspectSite, ProspectGeneration, ProspectPreview } from "@workspace/db";

export const prospectRouter: IRouter = Router();

// ─── Advisory lock key for prospect lifecycle operations ──────────────────────
// Separate namespace from duplicate-check locks (0x1a2b_3c4d).
// Ensures prospect and duplicate-check locks don't cross-block.
const PROSPECT_LOCK_NAMESPACE = 0x2b3c_4d5e;

function prospectLockKey(ownerId: string, leadId: string): bigint {
  // FNV-1a 32-bit hash of ownerId+leadId
  let hash = 0x811c_9dc5;
  const combined = `${ownerId}::${leadId}`;
  for (let i = 0; i < combined.length; i++) {
    hash ^= combined.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193);
  }
  return (BigInt(PROSPECT_LOCK_NAMESPACE) << 32n) | BigInt(hash >>> 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function acquireProspectLock(tx: any, ownerId: string, leadId: string): Promise<void> {
  const key = prospectLockKey(ownerId, leadId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(key))})`);
}

// ─── Prospect frozen client_previews helpers ──────────────────────────────────

/**
 * Derive the internal editorHash namespace value for a prospect frozen
 * client_previews row. Owner-derived and prefixed with the reserved prospect
 * namespace so:
 *   - it can never collide with an ordinary editor key hash (bare sha256 hex),
 *   - it is excluded from ordinary per-editor/total quota counts,
 *   - together with projectId (= websiteId) it satisfies the existing unique
 *     (editorHash, projectId) constraint on client_previews.
 */
export function prospectEditorHash(
  ownerId: string,
  prospectSiteId: string,
): string {
  return (
    PROSPECT_EDITOR_HASH_PREFIX +
    hashSecret(`prospect:${ownerId}:${prospectSiteId}`)
  );
}

/**
 * Transactionally delete prospect preview mappings for a lifecycle together
 * with the frozen client_previews rows they reference.
 *
 * Order-safe: we first capture the referenced clientPreviewIdHash values, then
 * delete the mapping rows, then delete the frozen client_previews rows. (The FK
 * is ON DELETE CASCADE in both directions relevant here, but deleting mappings
 * first then the frozen rows avoids relying on cascade ordering and makes the
 * dual cleanup explicit.)
 *
 * Returns the number of mapping rows removed.
 */
export async function deleteProspectPreviewsAndFrozenSites(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  where: ReturnType<typeof and> | ReturnType<typeof eq>,
): Promise<number> {
  const mappings = await tx
    .select({
      mappingId: prospectPreviewsTable.mappingId,
      clientPreviewIdHash: prospectPreviewsTable.clientPreviewIdHash,
    })
    .from(prospectPreviewsTable)
    .where(where);

  if (mappings.length === 0) return 0;

  const mappingIds = mappings.map((m: { mappingId: string }) => m.mappingId);
  const clientPreviewIdHashes = mappings.map(
    (m: { clientPreviewIdHash: string }) => m.clientPreviewIdHash,
  );

  await tx
    .delete(prospectPreviewsTable)
    .where(inArray(prospectPreviewsTable.mappingId, mappingIds));

  await tx
    .delete(clientPreviewsTable)
    .where(inArray(clientPreviewsTable.idHash, clientPreviewIdHashes));

  return mappings.length;
}

// ─── Serialization helpers ────────────────────────────────────────────────────

function serializeProspectSite(
  ps: ProspectSite,
  gen: ProspectGeneration | null,
  preview: ProspectPreview | null,
  websiteRevision: number | null,
) {
  const hasActivePreview = preview !== null && preview.expiresAt > new Date();
  // Recompute previewPath from stored mappingId — never log the result
  const previewPath = hasActivePreview ? buildPreviewPath(preview!.mappingId) : null;

  return {
    id: ps.id,
    leadId: ps.leadId,
    state: ps.state as "active_draft" | "archived" | "converted",
    websiteId: ps.websiteId ?? null,
    websiteRevision,
    templateId: gen?.templateId ?? null,
    generationCount: ps.generationCount,
    hasActivePreview,
    previewPath,
    previewExpiresAt: hasActivePreview ? preview!.expiresAt : null,
    createdAt: ps.createdAt,
    updatedAt: ps.updatedAt,
    archivedAt: ps.archivedAt ?? null,
    convertedAt: ps.convertedAt ?? null,
  };
}

/** Load lifecycle + latest generation + active preview for a prospect site */
async function loadProspectContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  txOrDb: any,
  ownerId: string,
  leadId: string,
  forUpdate = false,
): Promise<{
  ps: ProspectSite;
  gen: ProspectGeneration | null;
  preview: ProspectPreview | null;
  website: typeof siteforgeWebsitesTable.$inferSelect | null;
} | null> {
  const q = txOrDb
    .select()
    .from(prospectSitesTable)
    .where(
      and(
        eq(prospectSitesTable.leadId, leadId),
        eq(prospectSitesTable.ownerId, ownerId),
      ),
    )
    .limit(1);

  const [ps] = forUpdate ? await q.for("update") : await q;
  if (!ps) return null;

  // Latest active generation
  const [gen] = await txOrDb
    .select()
    .from(prospectGenerationsTable)
    .where(
      and(
        eq(prospectGenerationsTable.prospectSiteId, ps.id),
        eq(prospectGenerationsTable.status, "active"),
      ),
    )
    .limit(1);

  // Active unexpired preview
  const [preview] = await txOrDb
    .select()
    .from(prospectPreviewsTable)
    .where(
      and(
        eq(prospectPreviewsTable.prospectSiteId, ps.id),
        gt(prospectPreviewsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);

  // Website (for revision)
  let website: typeof siteforgeWebsitesTable.$inferSelect | null = null;
  if (ps.websiteId) {
    const [w] = await txOrDb
      .select()
      .from(siteforgeWebsitesTable)
      .where(
        and(
          eq(siteforgeWebsitesTable.ownerId, ownerId),
          eq(siteforgeWebsitesTable.id, ps.websiteId),
        ),
      )
      .limit(1);
    website = w ?? null;
  }

  return { ps, gen: gen ?? null, preview: preview ?? null, website };
}

// ─── Validate lead is eligible for prospect generation ────────────────────────

function validateLeadEligible(lead: Lead): string | null {
  if (lead.pipelineStatus !== "qualified") {
    return `Lead must be in 'qualified' status to generate a prospect site (currently '${lead.pipelineStatus}').`;
  }
  if (lead.suppressed) {
    return "Lead is suppressed (Do Not Contact) — prospect site generation is not allowed.";
  }
  return null;
}

// ─── Append provenance rows for verified fields ───────────────────────────────

/**
 * Append field-level provenance rows with provenance='verified' for each
 * selected non-empty stored field. Values come from the current DB lead row
 * (the same `lead` object that was read inside the transaction), never from
 * client request values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function appendVerifiedProvenance(
  tx: any,
  lead: Lead,
  ownerId: string,
  verifiedFields: Record<string, boolean>,
): Promise<void> {
  const rows = [];
  for (const field of PROSPECT_ALLOWED_FIELDS) {
    if (!verifiedFields[field]) continue;
    const value = (lead as unknown as Record<string, unknown>)[field];
    // Only insert for non-empty string values
    if (typeof value !== "string" || !value) continue;
    rows.push({
      id: newId(),
      leadId: lead.id,
      ownerId,
      fieldName: field,
      value,
      provenance: "verified",
    });
  }
  if (rows.length > 0) {
    await tx.insert(leadSourcesTable).values(rows);
  }
}

// ─── Core generation helper (shared by generate + regenerate) ─────────────────

async function performGeneration(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any;
  ownerId: string;
  lead: Lead;
  prospectSiteId: string;
  verifiedFields: Record<string, boolean>;
  templateIdOverride?: string;
  generationCount: number;
}): Promise<{
  websiteId: string;
  generationId: string;
  project: SiteProject;
  templateId: TemplateId;
}> {
  const { tx, ownerId, lead, prospectSiteId, verifiedFields, templateIdOverride, generationCount } = params;

  // Determine template
  let templateId: TemplateId;
  if (templateIdOverride && isValidTemplateId(templateIdOverride)) {
    templateId = templateIdOverride;
  } else {
    templateId = templateFromCategory(lead.category);
  }

  const websiteId = newId();
  const generationId = newId();

  // Build prospect project
  const project = generateProspectProject({
    websiteId,
    lead,
    verifiedFields,
    templateId,
    generationId,
  });

  // Sanitize for storage (strips any credentials that sneak in)
  const sanitized = sanitizeProjectSource(project as unknown as Record<string, unknown>);

  // Insert website
  await tx.insert(siteforgeWebsitesTable).values({
    ownerId,
    id: websiteId,
    name: lead.businessName,
    status: "active",
    siteType: "prospect",
    projectSource: sanitized,
    settings: {},
    revision: 0,
    schemaVersion: 1,
  });

  // Insert generation record (websiteRevision is integer 0 at creation)
  await tx.insert(prospectGenerationsTable).values({
    id: generationId,
    ownerId,
    leadId: lead.id,
    prospectSiteId,
    websiteId,
    status: "active",
    templateId,
    verifiedFieldsSnapshot: buildVerifiedFieldsSnapshot(lead, verifiedFields),
    websiteRevision: 0,
  });

  // Append field-level provenance rows (provenance='verified') for each selected
  // non-empty stored field. Uses current DB lead values — never client values.
  await appendVerifiedProvenance(tx, lead, ownerId, verifiedFields);

  void generationCount; // used by caller for lifecycle update

  return { websiteId, generationId, project, templateId };
}

// ─── GET /leads/:leadId/prospect-site ────────────────────────────────────────

prospectRouter.get(
  "/leads/:leadId/prospect-site",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = GetProspectSiteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    // Verify lead belongs to owner
    const [lead] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
      .limit(1);

    if (!lead) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }

    // Load prospect context — null if none exists (200+null stable empty state)
    const ctx = await loadProspectContext(db, ownerId, leadId);
    if (!ctx) {
      res.status(200).json(null);
      return;
    }

    const { ps, gen, preview, website } = ctx;
    res.status(200).json(
      GetProspectSiteResponse.parse(
        serializeProspectSite(ps, gen, preview, website?.revision ?? null),
      ),
    );
  },
);

// ─── POST /leads/:leadId/prospect-site ───────────────────────────────────────

prospectRouter.post(
  "/leads/:leadId/prospect-site",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = GenerateProspectSiteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const body = GenerateProspectSiteBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    // Validate verifiedFields: businessName required, only allowlisted keys
    const vf = body.data.verifiedFields as Record<string, boolean>;
    if (!vf.businessName) {
      res.status(400).json({ error: "verifiedFields.businessName must be true." });
      return;
    }
    for (const key of Object.keys(vf)) {
      if (!PROSPECT_ALLOWED_FIELDS.has(key)) {
        res.status(400).json({ error: `verifiedFields.${key} is not an allowed field.` });
        return;
      }
    }

    type TxResult =
      | { kind: "lead_not_found" }
      | { kind: "lead_ineligible"; reason: string }
      | { kind: "already_exists" }
      | { kind: "ok"; ps: ProspectSite; gen: ProspectGeneration | null; preview: ProspectPreview | null; website: typeof siteforgeWebsitesTable.$inferSelect | null };

    // Prospect-site generation writes VERIFIED lead source rows (the
    // provenance-approved facts that outreach's loadApprovedFacts reads), so it
    // can race an in-flight Gmail draft attempt. It must therefore hold the
    // SAME shared per-(owner,lead) lead-mutation lock (OUTER), with the existing
    // prospect xact lock INNER — ordering lead-session-lock → prospect-xact-lock,
    // consistent with every other inner xact lock, so no deadlock. All DB work
    // runs through the scoped lockedDb transaction.
    const txResult = await withLeadMutationLock(
      ownerId,
      leadId,
      (lockedDb) => lockedDb.transaction(async (tx): Promise<TxResult> => {
      await acquireProspectLock(tx, ownerId, leadId);

      const [lead] = await tx
        .select()
        .from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
        .limit(1)
        .for("update");
      if (!lead) return { kind: "lead_not_found" };

      const eligErr = validateLeadEligible(lead);
      if (eligErr) return { kind: "lead_ineligible", reason: eligErr };

      // Check for any existing lifecycle (active, archived, or converted).
      // The unique index (leadId, ownerId) will conflict on insert; check here
      // for a clearer error message.
      const [existing] = await tx
        .select()
        .from(prospectSitesTable)
        .where(
          and(
            eq(prospectSitesTable.leadId, leadId),
            eq(prospectSitesTable.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (existing) {
        return { kind: "already_exists" };
      }

      // Create lifecycle row (generationCount is integer)
      const prospectSiteId = newId();
      const [ps] = await tx
        .insert(prospectSitesTable)
        .values({
          id: prospectSiteId,
          ownerId,
          leadId,
          state: "active_draft",
          generationCount: 1,
          verifiedFieldsSnapshot: buildVerifiedFieldsSnapshot(lead, vf),
        })
        .returning();

      const { websiteId, generationId, templateId } = await performGeneration({
        tx,
        ownerId,
        lead,
        prospectSiteId,
        verifiedFields: vf,
        templateIdOverride: body.data.templateId ?? undefined,
        generationCount: 1,
      });

      // Update lifecycle with websiteId
      const [updatedPs] = await tx
        .update(prospectSitesTable)
        .set({ websiteId, updatedAt: new Date() })
        .where(eq(prospectSitesTable.id, prospectSiteId))
        .returning();

      await appendActivity({
        leadId,
        ownerId,
        activityType: "prospect_generated",
        note: `Prospect site generated using template '${templateId}'`,
        performedBy: ownerId,
      }, tx);

      // Load the website for revision
      const [website] = await tx
        .select()
        .from(siteforgeWebsitesTable)
        .where(and(eq(siteforgeWebsitesTable.ownerId, ownerId), eq(siteforgeWebsitesTable.id, websiteId)))
        .limit(1);

      const [gen] = await tx
        .select()
        .from(prospectGenerationsTable)
        .where(and(eq(prospectGenerationsTable.id, generationId)))
        .limit(1);

      return { kind: "ok", ps: updatedPs!, gen: gen ?? null, preview: null, website: website ?? null };
      }),
      (error) => req.log.error({ error: String(error), leadId }, "Failed to release lead-mutation lock (prospect generate)"),
    );

    if (txResult.kind === "lead_not_found") {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    if (txResult.kind === "lead_ineligible") {
      res.status(400).json({ error: txResult.reason });
      return;
    }
    if (txResult.kind === "already_exists") {
      res.status(409).json({ error: "A prospect lifecycle already exists for this lead." });
      return;
    }

    const { ps, gen, preview, website } = txResult;
    res.status(201).json(
      GenerateProspectSiteResponse.parse(
        serializeProspectSite(ps, gen, preview, website?.revision ?? null),
      ),
    );
  },
);

// ─── POST /leads/:leadId/prospect-site/regenerate ─────────────────────────────

prospectRouter.post(
  "/leads/:leadId/prospect-site/regenerate",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = RegenerateProspectSiteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const body = RegenerateProspectSiteBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const vf = body.data.verifiedFields as Record<string, boolean>;
    if (!vf.businessName) {
      res.status(400).json({ error: "verifiedFields.businessName must be true." });
      return;
    }
    for (const key of Object.keys(vf)) {
      if (!PROSPECT_ALLOWED_FIELDS.has(key)) {
        res.status(400).json({ error: `verifiedFields.${key} is not an allowed field.` });
        return;
      }
    }

    type TxResult =
      | { kind: "lead_not_found" }
      | { kind: "lead_ineligible"; reason: string }
      | { kind: "not_found" }
      | { kind: "terminal" }
      | { kind: "ok"; ps: ProspectSite; gen: ProspectGeneration | null; preview: null; website: typeof siteforgeWebsitesTable.$inferSelect | null };

    // Regenerate also rewrites VERIFIED lead source rows (see generate route);
    // same shared lead-mutation lock OUTER, prospect xact lock INNER.
    const txResult = await withLeadMutationLock(
      ownerId,
      leadId,
      (lockedDb) => lockedDb.transaction(async (tx): Promise<TxResult> => {
      await acquireProspectLock(tx, ownerId, leadId);

      const [lead] = await tx
        .select()
        .from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
        .limit(1)
        .for("update");
      if (!lead) return { kind: "lead_not_found" };

      const eligErr = validateLeadEligible(lead);
      if (eligErr) return { kind: "lead_ineligible", reason: eligErr };

      // Load existing lifecycle
      const [ps] = await tx
        .select()
        .from(prospectSitesTable)
        .where(
          and(
            eq(prospectSitesTable.leadId, leadId),
            eq(prospectSitesTable.ownerId, ownerId),
          ),
        )
        .limit(1)
        .for("update");
      if (!ps) return { kind: "not_found" };

      // Converted is terminal — reject always
      if (ps.state === "converted") return { kind: "terminal" };

      // Both active_draft and archived are regenerable
      const now = new Date();

      if (ps.state === "active_draft") {
        // 1. Archive old website (force concurrent Studio save conflict)
        if (ps.websiteId) {
          await tx
            .update(siteforgeWebsitesTable)
            .set({
              status: "archived",
              // Increment revision so any Studio save with old revision conflicts
              revision: sql`${siteforgeWebsitesTable.revision} + 1`,
              updatedAt: now,
            })
            .where(
              and(
                eq(siteforgeWebsitesTable.ownerId, ownerId),
                eq(siteforgeWebsitesTable.id, ps.websiteId),
              ),
            );
        }

        // 2. Supersede old generation
        await tx
          .update(prospectGenerationsTable)
          .set({ status: "superseded", supersededAt: now })
          .where(
            and(
              eq(prospectGenerationsTable.prospectSiteId, ps.id),
              eq(prospectGenerationsTable.status, "active"),
            ),
          );

        // 3. Revoke old preview (delete mapping + frozen client_previews rows)
        await deleteProspectPreviewsAndFrozenSites(
          tx,
          eq(prospectPreviewsTable.prospectSiteId, ps.id),
        );
      } else {
        // archived — supersede any archived generation records (no active ones)
        await tx
          .update(prospectGenerationsTable)
          .set({ status: "superseded", supersededAt: now })
          .where(
            and(
              eq(prospectGenerationsTable.prospectSiteId, ps.id),
              eq(prospectGenerationsTable.status, "archived"),
            ),
          );
      }

      // 4. New generation count
      const newCount = ps.generationCount + 1;

      // 5. Generate fresh website
      const { websiteId, generationId, templateId } = await performGeneration({
        tx,
        ownerId,
        lead,
        prospectSiteId: ps.id,
        verifiedFields: vf,
        templateIdOverride: body.data.templateId ?? undefined,
        generationCount: newCount,
      });

      // 6. Update lifecycle: restore to active_draft, point to new website,
      //    increment generationCount, clear archivedAt
      const [updatedPs] = await tx
        .update(prospectSitesTable)
        .set({
          state: "active_draft",
          websiteId,
          generationCount: newCount,
          verifiedFieldsSnapshot: buildVerifiedFieldsSnapshot(lead, vf),
          updatedAt: now,
          archivedAt: null,  // clear archivedAt on successful regenerate
        })
        .where(eq(prospectSitesTable.id, ps.id))
        .returning();

      await appendActivity({
        leadId,
        ownerId,
        activityType: "prospect_regenerated",
        note: `Prospect site regenerated using template '${templateId}' (generation ${newCount})`,
        performedBy: ownerId,
      }, tx);

      const [website] = await tx
        .select()
        .from(siteforgeWebsitesTable)
        .where(and(eq(siteforgeWebsitesTable.ownerId, ownerId), eq(siteforgeWebsitesTable.id, websiteId)))
        .limit(1);

      const [gen] = await tx
        .select()
        .from(prospectGenerationsTable)
        .where(eq(prospectGenerationsTable.id, generationId))
        .limit(1);

      return { kind: "ok", ps: updatedPs!, gen: gen ?? null, preview: null, website: website ?? null };
      }),
      (error) => req.log.error({ error: String(error), leadId }, "Failed to release lead-mutation lock (prospect regenerate)"),
    );

    if (txResult.kind === "lead_not_found") {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    if (txResult.kind === "lead_ineligible") {
      res.status(400).json({ error: txResult.reason });
      return;
    }
    if (txResult.kind === "not_found") {
      res.status(404).json({ error: "No prospect lifecycle found for this lead." });
      return;
    }
    if (txResult.kind === "terminal") {
      res.status(409).json({ error: "Converted prospect sites cannot be regenerated." });
      return;
    }

    const { ps, gen, website } = txResult;
    res.status(200).json(
      RegenerateProspectSiteResponse.parse(
        serializeProspectSite(ps, gen, null, website?.revision ?? null),
      ),
    );
  },
);

// ─── POST /leads/:leadId/prospect-site/preview ───────────────────────────────

prospectRouter.post(
  "/leads/:leadId/prospect-site/preview",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = PublishProspectPreviewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const body = PublishProspectPreviewBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const { expectedRevision } = body.data;

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      res.status(400).json({ error: "expectedRevision must be a safe non-negative integer." });
      return;
    }

    type TxResult =
      | { kind: "lead_not_found" }
      | { kind: "no_draft" }
      | { kind: "revision_conflict"; actual: number }
      | { kind: "validation_error"; reason: string }
      | { kind: "ok"; mappingId: string; expiresAt: Date; revision: number };

    const txResult = await db.transaction(async (tx): Promise<TxResult> => {
      await acquireProspectLock(tx, ownerId, leadId);

      // Verify lead belongs to owner
      const [lead] = await tx
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
        .limit(1);
      if (!lead) return { kind: "lead_not_found" };

      // Load lifecycle
      const [ps] = await tx
        .select()
        .from(prospectSitesTable)
        .where(and(eq(prospectSitesTable.leadId, leadId), eq(prospectSitesTable.ownerId, ownerId)))
        .limit(1)
        .for("update");
      if (!ps || ps.state !== "active_draft" || !ps.websiteId) {
        return { kind: "no_draft" };
      }

      // Load website and check revision
      const [website] = await tx
        .select()
        .from(siteforgeWebsitesTable)
        .where(and(eq(siteforgeWebsitesTable.ownerId, ownerId), eq(siteforgeWebsitesTable.id, ps.websiteId)))
        .limit(1)
        .for("update");
      if (!website) return { kind: "no_draft" };

      if (website.revision !== expectedRevision) {
        return { kind: "revision_conflict", actual: website.revision };
      }

      // Load the projectSource and validate prospect-safe
      const project = website.projectSource as unknown as SiteProject;
      const validationError = validateProspectSafeProject(project);
      if (validationError) {
        return { kind: "validation_error", reason: validationError };
      }

      // Server-side generateSite — produces the frozen site that will be served
      // verbatim on public delivery.
      let generated: StoredGeneratedSite;
      try {
        generated = generateSite(project) as StoredGeneratedSite;
      } catch {
        return {
          kind: "validation_error",
          reason: "The prospect site could not be generated.",
        };
      }

      // Run the SAME validation ordinary previews use before persisting.
      const siteError = validateSite(generated);
      if (siteError) {
        return { kind: "validation_error", reason: siteError };
      }

      // Generate signed mapping
      const mappingId = newMappingId();
      const signature = computeSignature(mappingId);
      const sigHash = hashSignature(signature);
      const expiresAt = previewExpiresAt();

      // Rotate: delete any existing preview mapping(s) for this lifecycle AND
      // the frozen client_previews rows they referenced (dual cleanup).
      await deleteProspectPreviewsAndFrozenSites(
        tx,
        eq(prospectPreviewsTable.prospectSiteId, ps.id),
      );

      // Freeze the generated site into a client_previews row. Internal
      // idHash/tokenHash are random and never exposed publicly; the editorHash
      // is owner-derived + prospect-namespaced (excluded from ordinary quotas,
      // satisfies unique (editorHash, projectId)); projectId = websiteId.
      const clientPreviewIdHash = hashSecret(newSecret());
      const clientPreviewTokenHash = hashSecret(newSecret());
      const projectUpdatedAt =
        project.updatedAt || website.sourceUpdatedAt || 0;
      await tx.insert(clientPreviewsTable).values({
        idHash: clientPreviewIdHash,
        tokenHash: clientPreviewTokenHash,
        editorHash: prospectEditorHash(ownerId, ps.id),
        projectId: ps.websiteId,
        projectUpdatedAt,
        site: generated,
        expiresAt: new Date(Date.now() + previewLifetimeMs),
      });

      // Insert new preview mapping referencing the frozen client_previews row.
      await tx.insert(prospectPreviewsTable).values({
        mappingId,
        signatureHash: sigHash,
        ownerId,
        leadId,
        prospectSiteId: ps.id,
        clientPreviewIdHash,
        websiteId: ps.websiteId,
        websiteRevision: website.revision,
        expiresAt,
      });

      return { kind: "ok", mappingId, expiresAt, revision: website.revision };
    });

    if (txResult.kind === "lead_not_found") {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    if (txResult.kind === "no_draft") {
      res.status(404).json({ error: "No active prospect draft found." });
      return;
    }
    if (txResult.kind === "revision_conflict") {
      res.status(409).json({
        error: `Revision conflict: expected ${expectedRevision}, actual ${txResult.actual}.`,
      });
      return;
    }
    if (txResult.kind === "validation_error") {
      res.status(400).json({ error: txResult.reason });
      return;
    }

    const { mappingId, expiresAt, revision } = txResult;
    // Build path — never log the signature portion
    const path = buildPreviewPath(mappingId);

    res.status(201).json(
      PublishProspectPreviewResponse.parse({
        mappingId,
        path,
        expiresAt,
        websiteRevision: revision,
      }),
    );
  },
);

// ─── DELETE /leads/:leadId/prospect-site/preview ─────────────────────────────

prospectRouter.delete(
  "/leads/:leadId/prospect-site/preview",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = RevokeProspectPreviewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    type TxResult =
      | { kind: "not_found" }
      | { kind: "no_preview" }
      | { kind: "ok" };

    const txResult = await db.transaction(async (tx): Promise<TxResult> => {
      await acquireProspectLock(tx, ownerId, leadId);

      // Load lifecycle to get prospectSiteId (within the lock)
      const [ps] = await tx
        .select()
        .from(prospectSitesTable)
        .where(
          and(eq(prospectSitesTable.leadId, leadId), eq(prospectSitesTable.ownerId, ownerId)),
        )
        .limit(1)
        .for("update");

      if (!ps) return { kind: "not_found" };

      // Delete mapping + referenced frozen client_previews rows transactionally.
      const deletedCount = await deleteProspectPreviewsAndFrozenSites(
        tx,
        and(
          eq(prospectPreviewsTable.prospectSiteId, ps.id),
          eq(prospectPreviewsTable.ownerId, ownerId),
        ),
      );

      if (deletedCount === 0) return { kind: "no_preview" };
      return { kind: "ok" };
    });

    if (txResult.kind === "not_found") {
      res.status(404).json({ error: "Prospect not found." });
      return;
    }
    if (txResult.kind === "no_preview") {
      res.status(404).json({ error: "No active preview to revoke." });
      return;
    }

    res.status(204).end();
  },
);

// ─── POST /leads/:leadId/prospect-site/archive ────────────────────────────────

prospectRouter.post(
  "/leads/:leadId/prospect-site/archive",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = ArchiveProspectSiteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    type TxResult =
      | { kind: "lead_not_found" }
      | { kind: "not_found" }
      | { kind: "already_done"; state: string }
      | { kind: "ok"; ps: ProspectSite };

    const txResult = await db.transaction(async (tx): Promise<TxResult> => {
      await acquireProspectLock(tx, ownerId, leadId);

      const [lead] = await tx
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
        .limit(1);
      if (!lead) return { kind: "lead_not_found" };

      const [ps] = await tx
        .select()
        .from(prospectSitesTable)
        .where(and(eq(prospectSitesTable.leadId, leadId), eq(prospectSitesTable.ownerId, ownerId)))
        .limit(1)
        .for("update");
      if (!ps) return { kind: "not_found" };
      if (ps.state !== "active_draft") return { kind: "already_done", state: ps.state };

      const now = new Date();

      // Archive the website — increment revision to conflict stale Studio saves
      if (ps.websiteId) {
        await tx
          .update(siteforgeWebsitesTable)
          .set({
            status: "archived",
            revision: sql`${siteforgeWebsitesTable.revision} + 1`,
            updatedAt: now,
          })
          .where(
            and(eq(siteforgeWebsitesTable.ownerId, ownerId), eq(siteforgeWebsitesTable.id, ps.websiteId)),
          );
      }

      // Mark generation(s) archived
      await tx
        .update(prospectGenerationsTable)
        .set({ status: "archived", archivedAt: now })
        .where(
          and(
            eq(prospectGenerationsTable.prospectSiteId, ps.id),
            eq(prospectGenerationsTable.status, "active"),
          ),
        );

      // Delete previews + referenced frozen client_previews rows.
      await deleteProspectPreviewsAndFrozenSites(
        tx,
        eq(prospectPreviewsTable.prospectSiteId, ps.id),
      );

      // Update lifecycle
      const [updatedPs] = await tx
        .update(prospectSitesTable)
        .set({ state: "archived", websiteId: null, archivedAt: now, updatedAt: now })
        .where(eq(prospectSitesTable.id, ps.id))
        .returning();

      await appendActivity({
        leadId,
        ownerId,
        activityType: "prospect_archived",
        note: "Prospect site archived",
        performedBy: ownerId,
      }, tx);

      return { kind: "ok", ps: updatedPs! };
    });

    if (txResult.kind === "lead_not_found") {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    if (txResult.kind === "not_found") {
      res.status(404).json({ error: "No prospect lifecycle found for this lead." });
      return;
    }
    if (txResult.kind === "already_done") {
      res.status(409).json({ error: `Prospect is already ${txResult.state}.` });
      return;
    }

    const { ps } = txResult;
    res.status(200).json(
      ArchiveProspectSiteResponse.parse(
        serializeProspectSite(ps, null, null, null),
      ),
    );
  },
);

// ─── POST /leads/:leadId/prospect-site/convert ────────────────────────────────

prospectRouter.post(
  "/leads/:leadId/prospect-site/convert",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = ConvertProspectSiteParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const body = ConvertProspectSiteBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const { expectedRevision } = body.data;

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      res.status(400).json({ error: "expectedRevision must be a safe non-negative integer." });
      return;
    }

    type TxResult =
      | { kind: "lead_not_found" }
      | { kind: "not_found" }
      | { kind: "already_done"; state: string }
      | { kind: "revision_conflict"; actual: number }
      | { kind: "ok"; websiteId: string; newRevision: number; lifecycleId: string };

    // Convert flips lead.pipelineStatus → won (pipeline/eligibility change) and
    // mutates prospect lifecycle/website state — same shared lead-mutation lock
    // OUTER, prospect xact lock INNER.
    const txResult = await withLeadMutationLock(
      ownerId,
      leadId,
      (lockedDb) => lockedDb.transaction(async (tx): Promise<TxResult> => {
      await acquireProspectLock(tx, ownerId, leadId);

      const [lead] = await tx
        .select()
        .from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
        .limit(1)
        .for("update");
      if (!lead) return { kind: "lead_not_found" };

      const [ps] = await tx
        .select()
        .from(prospectSitesTable)
        .where(and(eq(prospectSitesTable.leadId, leadId), eq(prospectSitesTable.ownerId, ownerId)))
        .limit(1)
        .for("update");
      if (!ps) return { kind: "not_found" };
      if (ps.state !== "active_draft" || !ps.websiteId) {
        return { kind: "already_done", state: ps.state };
      }

      // Load website and check revision
      const [website] = await tx
        .select()
        .from(siteforgeWebsitesTable)
        .where(and(eq(siteforgeWebsitesTable.ownerId, ownerId), eq(siteforgeWebsitesTable.id, ps.websiteId)))
        .limit(1)
        .for("update");
      if (!website) return { kind: "not_found" };

      if (website.revision !== expectedRevision) {
        return { kind: "revision_conflict", actual: website.revision };
      }

      const now = new Date();
      const newRevision = website.revision + 1;

      // Remove prospectMeta from projectSource (flip draft metadata) while
      // preserving all editable content/id. The project is now a customer site.
      let updatedProjectSource = website.projectSource as unknown as Record<string, unknown>;
      if (updatedProjectSource && typeof updatedProjectSource === "object") {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { prospectMeta: _dropped, ...rest } = updatedProjectSource as Record<string, unknown>;
        updatedProjectSource = rest;
      }

      // Convert the SAME website: change type to customer, status active,
      // remove prospectMeta, increment revision.
      // This preserves projectSource/id/history and forces concurrent Studio save conflict.
      await tx
        .update(siteforgeWebsitesTable)
        .set({
          siteType: "customer",
          status: "active",
          revision: newRevision,
          projectSource: updatedProjectSource,
          updatedAt: now,
        })
        .where(and(eq(siteforgeWebsitesTable.ownerId, ownerId), eq(siteforgeWebsitesTable.id, ps.websiteId)));

      // Mark generation converted
      await tx
        .update(prospectGenerationsTable)
        .set({ status: "converted", convertedAt: now })
        .where(
          and(
            eq(prospectGenerationsTable.prospectSiteId, ps.id),
            eq(prospectGenerationsTable.status, "active"),
          ),
        );

      // Delete previews + referenced frozen client_previews rows.
      await deleteProspectPreviewsAndFrozenSites(
        tx,
        eq(prospectPreviewsTable.prospectSiteId, ps.id),
      );

      // Mark lifecycle converted — keep websiteId for traceability
      await tx
        .update(prospectSitesTable)
        .set({ state: "converted", convertedAt: now, updatedAt: now })
        .where(eq(prospectSitesTable.id, ps.id));

      // Mark lead won
      await tx
        .update(leadsTable)
        .set({ pipelineStatus: "won", updatedAt: now })
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)));

      await appendActivity({
        leadId,
        ownerId,
        activityType: "prospect_converted",
        note: `Prospect site converted to customer website (revision ${newRevision})`,
        performedBy: ownerId,
      }, tx);

      return { kind: "ok", websiteId: ps.websiteId, newRevision, lifecycleId: ps.id };
      }),
      (error) => req.log.error({ error: String(error), leadId }, "Failed to release lead-mutation lock (prospect convert)"),
    );

    if (txResult.kind === "lead_not_found") {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    if (txResult.kind === "not_found") {
      res.status(404).json({ error: "No active prospect draft found." });
      return;
    }
    if (txResult.kind === "already_done") {
      res.status(409).json({ error: `Prospect is already ${txResult.state}.` });
      return;
    }
    if (txResult.kind === "revision_conflict") {
      res.status(409).json({
        error: `Revision conflict: expected ${expectedRevision}, actual ${txResult.actual}.`,
      });
      return;
    }

    const { websiteId, newRevision, lifecycleId } = txResult;
    res.status(200).json(
      ConvertProspectSiteResponse.parse({
        lifecycleId,
        websiteId,
        newRevision,
        leadStatus: "won",
      }),
    );
  },
);
