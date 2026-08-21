/**
 * studio-persistence-helpers.ts
 *
 * Pure, side-effect-free helpers for SiteForge Studio persistence.
 * No React, no DOM, no network – safe to import in Node tests.
 *
 * Exported from here and imported by use-studio.ts so tests use
 * the production implementations, not inline mirrors.
 */

import type { SiteProject, ReceptionistConfig } from '../lib/types';
import type {
  WebsiteImportResult,
  WebsiteImportItemResult,
  WebsiteRecord,
  WebsiteRename,
} from '@workspace/api-client-react';

// ─── Constants ────────────────────────────────────────────────────────────────
export const LEGACY_STORAGE_KEY = 'siteforge_projects';
export const PILOT_RETELL_AGENT_ID = 'agent_3e4f5dc655300344ba25df50f8';

/**
 * Credential-like field names stripped recursively from the entire project
 * before any server write. These are local-only secrets that must never leave
 * the browser.
 *
 * NOTE: hostedApiUrl and provisionedAt are intentionally NOT included here.
 * They are non-secret, schema-defined fields that the OpenAPI spec retains and
 * that clients may read back (e.g. for export compatibility). Only true secrets
 * belong in this set.
 */
export const SERVER_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'ownerKey',
  'ownerKeyHash',
  'setupKey',
  'secretKey',
  'apiKey',
  'apiSecret',
  'webhookSecret',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'privateKey',
]);

// ─── Scoped localStorage key helpers ─────────────────────────────────────────
export function scopedActiveKey(userId: string): string {
  return `siteforge_active_v2_${userId}`;
}
export function scopedCacheKey(userId: string): string {
  return `siteforge_cache_v2_${userId}`;
}
export function scopedMigrationKey(userId: string): string {
  return `siteforge_migrated_v2_${userId}`;
}

// ─── Sanitizer ────────────────────────────────────────────────────────────────
/**
 * Recursively strip SERVER_CREDENTIAL_KEYS from the entire project body
 * before sending it to the server.
 *
 * Recursion covers:
 *  - Plain objects (all own enumerable keys)
 *  - Arrays (each element)
 *
 * Scalars (string, number, boolean, null) are returned as-is.
 *
 * This is the single canonical sanitizer – use it before every API write.
 */
export function sanitizeProjectForServer(project: SiteProject): SiteProject {
  return deepStripCredentials(project as unknown as JsonValue) as unknown as SiteProject;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

function deepStripCredentials(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(deepStripCredentials);
  }
  if (value !== null && typeof value === 'object') {
    const result: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SERVER_CREDENTIAL_KEYS.has(k)) {
        result[k] = deepStripCredentials(v as JsonValue);
      }
    }
    return result;
  }
  return value;
}

// ─── Stable fingerprint ────────────────────────────────────────────────────────
/**
 * Stable serialization fingerprint for dirty-detection.
 *
 * Uses the full sanitized-project JSON so that two edits landing in the same
 * millisecond (same updatedAt, same name) are still distinguished.
 *
 * Credentials are stripped so the fingerprint is safe to log/compare without
 * risk of leaking secrets in console output.
 */
export function stableFingerprint(project: SiteProject): string {
  // sanitize before stringify so ownerKey fluctuations don't cause ghost saves
  const sanitized = sanitizeProjectForServer(project);
  return JSON.stringify(sanitized);
}

// ─── Rename helpers ───────────────────────────────────────────────────────────

/**
 * The backend is adding expectedRevision to WebsiteRename. Until codegen is
 * regenerated the generated type only has { name }. We extend it locally here
 * so the client can send the field immediately. The cast in buildRenameBody
 * keeps TypeScript happy while staying forward-compatible.
 *
 * Once codegen catches up this type can be replaced by the generated one.
 */
export type WebsiteRenameWithRevision = WebsiteRename & {
  /** Optimistic-concurrency revision. Backend increments on success; 409 on mismatch. */
  expectedRevision: number;
};

/**
 * Build the rename request body with the expected revision for optimistic
 * concurrency control.
 *
 * Pure function – safe to unit-test without a network or DOM.
 */
export function buildRenameBody(name: string, expectedRevision: number): WebsiteRenameWithRevision {
  return { name: name.trim(), expectedRevision };
}

/**
 * Parsed result of a 409 response from renameWebsite.
 *
 * serverProject has the canonical name from the DB row overlaid (record.name
 * wins over projectSource.name, same as recordToProject).
 */
export type RenameConflict = {
  serverRevision: number;
  serverProject: SiteProject;
};

/**
 * Extract a RenameConflict from a 409 error thrown by renameWebsite.
 *
 * Returns null if the error is not a coherent 409 conflict (wrong status,
 * missing data, or data that can't be parsed).
 *
 * Pure function – safe to unit-test.
 */
export function extractRenameConflict(err: unknown): RenameConflict | null {
  if (!isApiError(err) || err.status !== 409) return null;
  const data = err.data as { current?: WebsiteRecord } | null | undefined;
  if (!data?.current) return null;

  const record = data.current;
  const rawProject = record.projectSource as SiteProject;
  // Overlay canonical name from DB row, same as recordToProject
  const serverProject: SiteProject =
    rawProject.name !== record.name
      ? { ...rawProject, name: record.name }
      : rawProject;

  return { serverRevision: record.revision, serverProject };
}

// ─── Migration helpers ────────────────────────────────────────────────────────
export function isRetiredNorthlineProject(project: SiteProject): boolean {
  return (
    project.business?.name === 'Northline Services' ||
    project.business?.email === 'hello@northline.ca'
  );
}

export function applyReceptionistMigration(project: SiteProject): SiteProject {
  const p = { ...project };
  if (
    !p.receptionist ||
    typeof p.receptionist.enabled !== 'boolean' ||
    !p.receptionist.assistantName ||
    p.receptionist.retellAgentId !== PILOT_RETELL_AGENT_ID
  ) {
    p.receptionist = {
      enabled: false,
      assistantName: 'Assistant',
      ...(p.receptionist ?? {}),
      retellAgentId: PILOT_RETELL_AGENT_ID,
    };
  }
  return p;
}

/**
 * Read legacy projects from localStorage without mutating or deleting the key.
 * Returns [] on any error.
 */
export function readLegacyProjects(): SiteProject[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SiteProject[];
  } catch {
    return [];
  }
}

/**
 * Apply in-memory migrations (receptionist defaults + retired Northline filter).
 * Never mutates the input array.
 */
export function applyLocalMigrations(projects: SiteProject[]): SiteProject[] {
  return projects
    .map(applyReceptionistMigration)
    .filter(p => !isRetiredNorthlineProject(p));
}

/**
 * Whether a local project is valid enough to import to the server.
 */
export function isImportable(p: SiteProject): boolean {
  return (
    typeof p.id === 'string' &&
    p.id.length > 0 &&
    typeof p.name === 'string' &&
    p.name.length > 0 &&
    typeof p.createdAt === 'number' &&
    typeof p.updatedAt === 'number' &&
    !!p.pages &&
    !!p.designTokens
  );
}

/**
 * Migration is definitively complete ONLY when ALL of:
 *  - errors === 0
 *  - result.results.length === submittedCount (exact item count)
 *  - every item status is 'imported' or 'skipped'  ('updated' is rejected)
 *  - the aggregate counts agree: imported + skipped === submittedCount
 *
 * Any 'updated' status indicates a pre-existing server row with a different
 * revision, which must be treated as a non-clean migration for auditing.
 */
export function isMigrationComplete(
  result: WebsiteImportResult,
  submittedCount: number
): boolean {
  if (result.errors !== 0) return false;
  if (result.results.length !== submittedCount) return false;

  const onlyImportedOrSkipped = result.results.every(
    (r: WebsiteImportItemResult) => r.status === 'imported' || r.status === 'skipped'
  );
  if (!onlyImportedOrSkipped) return false;

  // Aggregate must match too (guards against server lying about counts vs items)
  if (result.imported + result.skipped !== submittedCount) return false;

  return true;
}

// ─── ownerKey merge ───────────────────────────────────────────────────────────
/**
 * Merge a local-only ownerKey back into a project that came from the server,
 * but ONLY if the project IDs match and the server project has a receptionist.
 * Never merges ownerKey from a different project.
 */
export function mergeLocalOwnerKey(
  serverProject: SiteProject,
  cachedProject: SiteProject | undefined
): SiteProject {
  if (!serverProject.receptionist) return serverProject;
  if (!cachedProject) return serverProject;
  if (cachedProject.id !== serverProject.id) return serverProject;

  const cachedOwnerKey = (cachedProject.receptionist as (ReceptionistConfig & { ownerKey?: string }) | undefined)
    ?.ownerKey;
  if (!cachedOwnerKey) return serverProject;

  return {
    ...serverProject,
    receptionist: {
      ...serverProject.receptionist,
      ownerKey: cachedOwnerKey,
    },
  };
}

/**
 * Normalize a WebsiteRecord's embedded projectSource into a canonical SiteProject.
 *
 * The DB row is authoritative for identity: both record.id and record.name are
 * overlaid onto projectSource BEFORE the ownerKey merge. This defends against
 * responses (notably duplicate/create) where the embedded projectSource still
 * carries a stale source id/name that does not match the newly-minted DB row.
 * By overlaying the canonical id first, the ownerKey merge — which is keyed on
 * cachedProject.id === serverProject.id — is guaranteed to match the cache entry
 * for the canonical ID, never the source ID.
 *
 * Pure function – safe to unit-test without React, DOM, or network.
 */
export function normalizeRecordProject(
  record: WebsiteRecord,
  cachedProject: SiteProject | undefined
): SiteProject {
  const base = record.projectSource as SiteProject;
  // Overlay canonical id + name from the DB row before anything else, so all
  // downstream logic (ownerKey merge, cache keys, dirty tracking) sees a single
  // consistent identity. Only allocate a new object when something actually differs.
  const needsId = base.id !== record.id;
  const needsName = base.name !== record.name;
  const canonical: SiteProject =
    needsId || needsName
      ? { ...base, id: record.id, name: record.name }
      : base;
  return mergeLocalOwnerKey(canonical, cachedProject);
}

// ─── Error helpers ────────────────────────────────────────────────────────────
export function isApiError(err: unknown): err is { status: number; data: unknown } {
  return (
    err !== null &&
    typeof err === 'object' &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  );
}

export function extractErrorMessage(err: unknown): string {
  if (!err) return 'Unknown error';
  if (err instanceof Error) return err.message;
  if (isApiError(err)) {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'error' in data) {
      const msg = (data as { error?: unknown }).error;
      if (typeof msg === 'string') return msg;
    }
    return `HTTP ${(err as { status: number }).status}`;
  }
  return String(err);
}
