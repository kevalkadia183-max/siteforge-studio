/**
 * use-studio.ts – server-backed studio persistence
 *
 * Architecture:
 * - PostgreSQL (via API) is always authoritative. Local storage is draft cache
 *   and migration source only – never the authority for a signed-in user.
 * - On mount: wait for getAccount(); if that fails → expose initError with retry.
 *   Never silently fall back to local/legacy mode for authenticated requests.
 * - One-time migration: read legacy key read-only, import to server, seed cache
 *   with ownerKeys, mark complete only on exact completion criteria. If migration
 *   fails (throws or returns incomplete), stop and show initError; do not hydrate.
 * - Dirty-flag + full-JSON fingerprint prevents spurious PUT and catches same-ms edits.
 * - Saves are serialized via a mutex: only one PUT in-flight at a time. If edits
 *   land while a save is in-flight, isDirty stays true after the save completes
 *   and a new save is queued automatically.
 * - Save status goes to 'saving' immediately when an edit makes the state dirty
 *   (debounce fires within the effect; status shown promptly).
 * - Debounced PUT save with expectedRevision; 409 → conflict state.
 * - switchProject uses getWebsite() to fetch owner-scoped detail.
 * - switchProject is blocked while an unresolved conflict exists.
 * - resolveConflictLoadServer merges the local draft's ownerKey into server version.
 * - delete-last: create fresh replacement (createNewProject, not getSeedProject)
 *   FIRST, then delete target. If delete fails, attempt rollback of replacement,
 *   leave UI unchanged, return false.
 * - newProject and duplicateProject flush current dirty draft first.
 * - setActivePage persists without undo history: marks dirty, triggers debounce.
 * - renameProject: if draft is dirty, keep dirty; if clean, update baseline.
 * - recordToProject always overlays record.name so renames survive reload.
 * - All CRUD returns Promise<boolean>; callers keep dialogs open on false.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  SiteProject,
  ReceptionistConfig,
  PageId,
  SectionData,
  DesignTokens,
  BusinessInfo,
  TemplateId,
  BriefDraft,
  BriefDraftSelection,
  HistoryState,
} from '../lib/types';
import { createNewProject, createDefaultSection, TEMPLATES } from '../lib/templates';
import {
  getProjectMediaStats,
  MAX_LOCAL_PROJECTS_LENGTH,
  MAX_PROJECT_MEDIA_ASSETS,
  MAX_PROJECT_MEDIA_DATA_LENGTH,
} from '../lib/media';
import {
  getAccount,
  listWebsites,
  getWebsite,
  createWebsite,
  importWebsites,
  saveWebsite,
  renameWebsite,
  duplicateWebsite,
  deleteWebsite,
} from '@workspace/api-client-react';
import type { WebsiteRecord, WebsiteConflict } from '@workspace/api-client-react';
import {
  scopedActiveKey,
  scopedCacheKey,
  scopedMigrationKey,
  sanitizeProjectForServer,
  stableFingerprint,
  readLegacyProjects,
  applyLocalMigrations,
  isImportable,
  isMigrationComplete,
  mergeLocalOwnerKey,
  normalizeRecordProject,
  isApiError,
  extractErrorMessage,
  buildRenameBody,
  extractRenameConflict,
} from './studio-persistence-helpers';
import type { WebsiteRenameWithRevision } from './studio-persistence-helpers';
import { applySelectedBriefDraftToHistory } from '../lib/brief-generator';

// ─── Types ────────────────────────────────────────────────────────────────────
export type SaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

export type ConflictState = {
  serverId: string;
  serverRevision: number;
  serverProject: SiteProject;
  localDraft: SiteProject;
};

// ─── Per-user scoped localStorage cache ──────────────────────────────────────
function readCache(userId: string): Map<string, SiteProject> {
  try {
    const raw = localStorage.getItem(scopedCacheKey(userId));
    if (!raw) return new Map();
    const arr: Array<{ id: string; project: SiteProject }> = JSON.parse(raw);
    return new Map(arr.map(({ id, project }) => [id, project]));
  } catch {
    return new Map();
  }
}

function writeCache(userId: string, map: Map<string, SiteProject>): void {
  try {
    const arr = [...map.entries()].map(([id, project]) => ({ id, project }));
    localStorage.setItem(scopedCacheKey(userId), JSON.stringify(arr));
  } catch {
    // Quota exceeded – best effort
  }
}

function readActiveId(userId: string): string | null {
  return localStorage.getItem(scopedActiveKey(userId));
}

function writeActiveId(userId: string, id: string): void {
  localStorage.setItem(scopedActiveKey(userId), id);
}

function hasMigrated(userId: string): boolean {
  return localStorage.getItem(scopedMigrationKey(userId)) === 'done';
}

function markMigrated(userId: string): void {
  localStorage.setItem(scopedMigrationKey(userId), 'done');
}

// ─── Revision map (module-level, cleared on unmount) ─────────────────────────
const revisionMap = new Map<string, number>();

// ─── Convert WebsiteRecord → SiteProject ─────────────────────────────────────
/**
 * record.id and record.name are always canonical (DB row wins over
 * projectSource identity). Both are overlaid before the local-only ownerKey is
 * merged back from cache, so the merge is keyed strictly to the canonical ID.
 * Delegates to the pure normalizeRecordProject helper (unit-tested).
 */
function recordToProject(record: WebsiteRecord, cache: Map<string, SiteProject>): SiteProject {
  const cached = cache.get(record.id);
  return normalizeRecordProject(record, cached);
}

// ─── Main hook ────────────────────────────────────────────────────────────────
export function useStudio() {
  const [projects, setProjects] = useState<SiteProject[]>([]);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [projectSiteTypes, setProjectSiteTypes] = useState<Record<string, string>>({});

  // Track current user id for scoping
  const userIdRef = useRef<string | null>(null);
  // Guard async callbacks after unmount or user change
  const mountedRef = useRef(true);
  // Dirty flag: true only after real edits; reset only after a successful save
  // that captured the latest state
  const isDirtyRef = useRef(false);
  // Fingerprint of the last successfully saved state (sanitized JSON)
  const cleanFingerprintRef = useRef<string>('');
  // Mirror of history.present for use inside async callbacks without stale closure
  const currentProjectRef = useRef<SiteProject | null>(null);
  // Save-serialization mutex: resolves when the in-flight save finishes
  const saveMutexRef = useRef<Promise<boolean>>(Promise.resolve(true));
  // Re-initialize trigger
  const [initTrigger, setInitTrigger] = useState(0);

  // ─── retryInitialization ──────────────────────────────────────────────────
  const retryInitialization = useCallback(() => {
    setInitError(null);
    setIsReady(false);
    setInitTrigger(n => n + 1);
  }, []);

  // ─── Validation ──────────────────────────────────────────────────────────────
  const validateProjectCollection = useCallback(
    (project: SiteProject, collection: SiteProject[]) => {
      const stats = getProjectMediaStats(project);
      if (stats.count > MAX_PROJECT_MEDIA_ASSETS) {
        window.alert(
          `This project can contain up to ${MAX_PROJECT_MEDIA_ASSETS} images. Remove an image before adding another.`,
        );
        return false;
      }
      if (stats.encodedLength > MAX_PROJECT_MEDIA_DATA_LENGTH) {
        window.alert(
          'This project has reached its 2.8 MB optimized image allowance. Remove or replace an image before adding another.',
        );
        return false;
      }
      if (JSON.stringify(collection).length > MAX_LOCAL_PROJECTS_LENGTH) {
        window.alert(
          "SiteForge has reached this browser's local project storage allowance. Delete an unused project or remove images before continuing.",
        );
        return false;
      }
      return true;
    },
    [],
  );

  const validateProjectUpdate = useCallback(
    (project: SiteProject) => {
      const collection = projects.some(item => item.id === project.id)
        ? projects.map(item => (item.id === project.id ? project : item))
        : [...projects, project];
      return validateProjectCollection(project, collection);
    },
    [projects, validateProjectCollection],
  );

  // ─── History management ───────────────────────────────────────────────────
  const pushState = useCallback(
    (newPresent: SiteProject, enforceMediaBudget: boolean | undefined = false) => {
      if (enforceMediaBudget && !validateProjectUpdate(newPresent)) return;
      isDirtyRef.current = true;
      const withTs: SiteProject = { ...newPresent, updatedAt: Date.now() };
      currentProjectRef.current = withTs;
      setHistory(current => {
        if (!current) return current;
        return {
          past: [...current.past, current.present].slice(-50),
          present: withTs,
          future: [],
        };
      });
    },
    [validateProjectUpdate],
  );

  const undo = useCallback(() => {
    setHistory(current => {
      if (!current || current.past.length === 0) return current;
      isDirtyRef.current = true;
      const previous = current.past[current.past.length - 1];
      currentProjectRef.current = previous;
      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory(current => {
      if (!current || current.future.length === 0) return current;
      isDirtyRef.current = true;
      const next = current.future[0];
      currentProjectRef.current = next;
      return {
        past: [...current.past, current.present],
        present: next,
        future: current.future.slice(1),
      };
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        if (e.shiftKey) {
          e.preventDefault();
          redo();
        } else {
          e.preventDefault();
          undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  // ─── Serialized server save ───────────────────────────────────────────────
  /**
   * Enqueues a save through saveMutexRef so only one PUT is in-flight at a
   * time. After each save completes it checks whether the latest present
   * differs from the just-saved fingerprint; if so it immediately queues
   * another save rather than showing 'Saved' prematurely.
   */
  const serverSave = useCallback(async (project: SiteProject): Promise<boolean> => {
    // Serialize: wait for any in-flight save to finish before starting ours
    let resolveOwnLock!: (v: boolean) => void;
    const ownLock = new Promise<boolean>(res => { resolveOwnLock = res; });
    const previousLock = saveMutexRef.current;
    saveMutexRef.current = ownLock;

    // Wait for previous save to settle (we don't need its result here)
    await previousLock.catch(() => {});

    const userId = userIdRef.current;
    if (!mountedRef.current || !userId) {
      resolveOwnLock(false);
      return false;
    }

    const revision = revisionMap.get(project.id) ?? 0;
    setSaveStatus('saving');
    setSaveError(null);

    let result = false;
    try {
      const sanitized = sanitizeProjectForServer(project);
      const record = await saveWebsite(project.id, {
        name: project.name,
        projectSource: sanitized,
        expectedRevision: revision,
        sourceUpdatedAt: project.updatedAt,
      });

      if (!mountedRef.current) {
        resolveOwnLock(false);
        return false;
      }

      revisionMap.set(project.id, record.revision);

      // Cache locally with ownerKey preserved (server response never has ownerKey)
      const uid = userIdRef.current;
      if (uid) {
        const cache = readCache(uid);
        cache.set(project.id, project); // project still has in-memory ownerKey
        writeCache(uid, cache);
      }

      // Only clear dirty if the current live state hasn't changed since we started
      const savedFp = stableFingerprint(project);
      const currentFp = currentProjectRef.current
        ? stableFingerprint(currentProjectRef.current)
        : savedFp;

      if (currentFp === savedFp) {
        // Nothing changed while saving – truly clean
        isDirtyRef.current = false;
        cleanFingerprintRef.current = savedFp;
        setSaveStatus('saved');
      } else {
        // Edit B arrived while save A was in flight; keep dirty, queue another save
        isDirtyRef.current = true;
        cleanFingerprintRef.current = savedFp;
        // Let the debounce effect pick up the still-dirty state on next render
        setSaveStatus('saving');
      }

      result = true;
    } catch (err: unknown) {
      if (!mountedRef.current) {
        resolveOwnLock(false);
        return false;
      }

      if (isApiError(err) && err.status === 409) {
        const data = err.data as WebsiteConflict | null;
        if (data?.current) {
          // Apply canonical name from DB row in conflict too
          const rawServer = data.current.projectSource as SiteProject;
          const serverProject: SiteProject =
            rawServer.name !== data.current.name
              ? { ...rawServer, name: data.current.name }
              : rawServer;
          setConflictState({
            serverId: project.id,
            serverRevision: data.current.revision,
            serverProject,
            localDraft: project,
          });
          setSaveStatus('conflict');
          resolveOwnLock(false);
          return false;
        }
      }

      setSaveStatus('error');
      setSaveError(extractErrorMessage(err));
      result = false;
    }

    resolveOwnLock(result);
    return result;
  }, []);

  // ─── Debounced auto-save ──────────────────────────────────────────────────
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const present = history?.present;
    if (!present || !isReady) return;

    // Keep currentProjectRef in sync with history.present
    currentProjectRef.current = present;

    if (!isDirtyRef.current) return;

    // Show 'saving' immediately so user knows a save is pending
    const fp = stableFingerprint(present);
    if (fp === cleanFingerprintRef.current) {
      // Fingerprint matches clean baseline – no content change despite dirty flag
      isDirtyRef.current = false;
      return;
    }

    setSaveStatus('saving');

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const toSave = currentProjectRef.current;
      if (toSave && isDirtyRef.current) {
        serverSave(toSave).catch(err =>
          console.error('[use-studio] debounced save failed', err),
        );
      }
    }, 1200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history?.present, isReady]);

  // ─── saveNow ──────────────────────────────────────────────────────────────
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const toSave = currentProjectRef.current;
    if (!toSave) return false;
    if (!isDirtyRef.current && saveStatus === 'saved') return true;
    return serverSave(toSave);
  }, [saveStatus, serverSave]);

  // ─── retrySave ───────────────────────────────────────────────────────────
  const retrySave = useCallback(async (): Promise<boolean> => {
    const toSave = currentProjectRef.current;
    if (!toSave) return false;
    setSaveError(null);
    isDirtyRef.current = true;
    return serverSave(toSave);
  }, [serverSave]);

  // ─── Conflict resolution ─────────────────────────────────────────────────
  /**
   * Load server version – merge the local draft's ownerKey so it is not lost.
   */
  const resolveConflictLoadServer = useCallback(() => {
    if (!conflictState) return;
    const userId = userIdRef.current;

    // Restore ownerKey from local draft into the server version
    const merged = mergeLocalOwnerKey(conflictState.serverProject, conflictState.localDraft);

    if (userId) {
      revisionMap.set(conflictState.serverId, conflictState.serverRevision);
      const cache = readCache(userId);
      cache.set(conflictState.serverId, merged);
      writeCache(userId, cache);
    }

    isDirtyRef.current = false;
    cleanFingerprintRef.current = stableFingerprint(merged);
    currentProjectRef.current = merged;

    setHistory(_curr => ({ past: [], present: merged, future: [] }));
    setProjects(prev =>
      prev.map(p => (p.id === conflictState.serverId ? merged : p)),
    );
    setConflictState(null);
    setSaveStatus('saved');
    setSaveError(null);
  }, [conflictState]);

  const resolveConflictOverwrite = useCallback(async (): Promise<boolean> => {
    if (!conflictState) return false;

    // Advance the revision map to the server's current so our PUT won't 409 again.
    revisionMap.set(conflictState.serverId, conflictState.serverRevision);
    isDirtyRef.current = true;

    // Prefer the latest live draft over the snapshot captured at conflict time.
    // If the user kept editing after the conflict banner appeared, currentProjectRef
    // holds those changes. The snapshot (conflictState.localDraft) is only a
    // fallback when the project was switched away in the meantime.
    // Always preserve the local ownerKey from whichever source has it.
    const live = currentProjectRef.current;
    const snapshot = conflictState.localDraft;
    let toSave: SiteProject;
    if (live && live.id === conflictState.serverId) {
      // Re-merge the ownerKey from the snapshot in case it was only stored there
      toSave = mergeLocalOwnerKey(live, snapshot);
    } else {
      toSave = snapshot;
    }

    const ok = await serverSave(toSave);
    if (ok) setConflictState(null);
    return ok;
  }, [conflictState, serverSave]);

  // ─── Initialization ───────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    isDirtyRef.current = false;
    cleanFingerprintRef.current = '';
    currentProjectRef.current = null;

    async function init() {
      // 1. Authenticate – fail visibly, never fall back to local authority
      let userId: string;
      try {
        const account = await getAccount();
        if (!mountedRef.current) return;
        userId = account.userId;
      } catch (err) {
        if (!mountedRef.current) return;
        setInitError(`Could not load your account: ${extractErrorMessage(err)}`);
        return;
      }

      userIdRef.current = userId;

      // 2. One-time migration – must succeed before hydration
      if (!hasMigrated(userId)) {
        const migrationOk = await runMigration(userId);
        if (!mountedRef.current) return;
        if (!migrationOk) {
          // initError was set inside runMigration; stop here, do NOT hydrate
          return;
        }
      }

      // 3. Hydrate from server
      await hydrateFromServer(userId);
    }

    init().catch(err => {
      console.error('[use-studio] init failed', err);
      if (mountedRef.current) {
        setInitError(`Failed to load studio: ${extractErrorMessage(err)}`);
      }
    });

    return () => {
      mountedRef.current = false;
      revisionMap.clear();
      userIdRef.current = null;
      currentProjectRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initTrigger]);

  // ─── hydrateFromServer ────────────────────────────────────────────────────
  async function hydrateFromServer(userId: string) {
    try {
      const list = await listWebsites();
      if (!mountedRef.current) return;

      const cache = readCache(userId);

      if (list.websites.length === 0) {
        // No projects on server – create a fresh one
        const seed = createNewProject('My First Project', 'home-services');
        let record: WebsiteRecord;
        try {
          record = await createWebsite({
            id: seed.id,
            name: seed.name,
            projectSource: sanitizeProjectForServer(seed),
          });
        } catch (err) {
          if (!mountedRef.current) return;
          setInitError(`Could not create initial project: ${extractErrorMessage(err)}`);
          return;
        }
        if (!mountedRef.current) return;

        revisionMap.set(record.id, record.revision);
        setProjectSiteTypes({ [record.id]: record.siteType });
        const seedProject = recordToProject(record, cache);
        cache.set(record.id, seedProject);
        writeCache(userId, cache);
        writeActiveId(userId, record.id);

        isDirtyRef.current = false;
        cleanFingerprintRef.current = stableFingerprint(seedProject);
        currentProjectRef.current = seedProject;
        setProjects([seedProject]);
        setHistory({ past: [], present: seedProject, future: [] });
        setSaveStatus('saved');
        setIsReady(true);
        return;
      }

      const newSiteTypes: Record<string, string> = {};
      list.websites.forEach(r => {
        revisionMap.set(r.id, r.revision);
        newSiteTypes[r.id] = r.siteType;
      });
      setProjectSiteTypes(newSiteTypes);
      const serverProjects = list.websites.map(r => recordToProject(r, cache));

      const savedActiveId = readActiveId(userId);
      const active =
        serverProjects.find(p => p.id === savedActiveId) ?? serverProjects[0];

      // Refresh cache to match server list (ownerKeys already merged into serverProjects)
      const newCache = new Map<string, SiteProject>();
      serverProjects.forEach(p => newCache.set(p.id, p));
      writeCache(userId, newCache);
      writeActiveId(userId, active.id);

      isDirtyRef.current = false;
      cleanFingerprintRef.current = stableFingerprint(active);
      currentProjectRef.current = active;
      setProjects(serverProjects);
      setHistory({ past: [], present: active, future: [] });
      setSaveStatus('saved');
      setIsReady(true);
    } catch (err) {
      if (!mountedRef.current) return;
      setInitError(`Could not load your projects: ${extractErrorMessage(err)}`);
    }
  }

  // ─── runMigration ─────────────────────────────────────────────────────────
  /**
   * Returns true only if migration is complete and marked 'done'.
   * Returns false on any failure and sets initError so UI shows retry.
   * Always seeds per-user cache with ownerKeys from local projects first.
   */
  async function runMigration(userId: string): Promise<boolean> {
    const legacy = readLegacyProjects();
    const migrated = applyLocalMigrations(legacy);
    const importable = migrated.filter(isImportable);

    // Pre-populate cache with ownerKeys BEFORE hydration
    if (importable.length > 0) {
      const cache = readCache(userId);
      let cacheChanged = false;
      for (const p of importable) {
        const ownerKey = (
          p.receptionist as (typeof p.receptionist & { ownerKey?: string }) | undefined
        )?.ownerKey;
        if (ownerKey) {
          const existing = cache.get(p.id);
          const existingKey = (
            existing?.receptionist as (ReceptionistConfig & { ownerKey?: string }) | undefined
          )?.ownerKey;
          if (!existingKey) {
            cache.set(p.id, p);
            cacheChanged = true;
          }
        }
      }
      if (cacheChanged) writeCache(userId, cache);
    }

    if (importable.length === 0) {
      markMigrated(userId);
      return true;
    }

    try {
      const result = await importWebsites({
        websites: importable.map(p => ({
          id: p.id,
          name: p.name,
          projectSource: sanitizeProjectForServer(p),
          sourceUpdatedAt: p.updatedAt,
        })),
      });
      if (!mountedRef.current) return false;

      if (isMigrationComplete(result, importable.length)) {
        markMigrated(userId);
        return true;
      }

      // Incomplete but did not throw – surface a useful error
      const updatedCount = result.results.filter(r => r.status === 'updated').length;
      const errMsg = updatedCount > 0
        ? `Migration found ${updatedCount} project(s) already on the server with conflicting data ('updated' status is not accepted for a clean migration). Please contact support or retry.`
        : `Migration incomplete: ${result.errors} error(s), ${result.imported} imported, ${result.updated} updated, ${result.skipped} skipped of ${importable.length} submitted.`;
      setInitError(errMsg);
      return false;
    } catch (err) {
      console.error('[use-studio] migration failed', err);
      if (!mountedRef.current) return false;
      setInitError(
        `Migration failed: ${extractErrorMessage(err)}. Your local projects are preserved. Click Retry to try again.`,
      );
      return false;
    }
  }

  // ─── Editor actions ───────────────────────────────────────────────────────
  const updateBusiness = (updates: Partial<BusinessInfo>) => {
    if (!history?.present) return;
    pushState(
      { ...history.present, business: { ...history.present.business, ...updates } },
      'logo' in updates,
    );
  };

  const updateTokens = (updates: Partial<DesignTokens>) => {
    if (!history?.present) return;
    pushState({ ...history.present, designTokens: { ...history.present.designTokens, ...updates } });
  };

  const updateReceptionist = (
    updates: Partial<NonNullable<SiteProject['receptionist']>>,
  ) => {
    if (!history?.present) return;
    pushState({
      ...history.present,
      receptionist: {
        ...(history.present.receptionist || { enabled: false, assistantName: 'Assistant' }),
        ...updates,
      },
    });
  };

  /**
   * setActivePage: persists active page without adding undo history.
   * Marks dirty + updates updatedAt so the change is saved to the server.
   */
  const setActivePage = (pageId: PageId) => {
    if (!history?.present) return;
    const next: SiteProject = {
      ...history.present,
      activePageId: pageId,
      updatedAt: Date.now(),
    };
    isDirtyRef.current = true;
    currentProjectRef.current = next;
    // No history push – just update present without adding to undo stack
    setHistory(curr =>
      curr ? { ...curr, present: next } : curr,
    );
  };

  const updateSection = (
    pageId: PageId,
    sectionId: string,
    updates: Partial<SectionData>,
  ) => {
    if (!history?.present) return;
    const page = history.present.pages[pageId];
    pushState(
      {
        ...history.present,
        pages: {
          ...history.present.pages,
          [pageId]: {
            ...page,
            sections: page.sections.map(s => (s.id === sectionId ? { ...s, ...updates } : s)),
          },
        },
      },
      'image' in updates || 'items' in updates,
    );
  };

  const applyBriefDraft = (draft: BriefDraft, selection: BriefDraftSelection) =>
    new Promise<boolean>(resolve => {
      setHistory(current => {
        const result = applySelectedBriefDraftToHistory(
          current,
          draft,
          selection,
          Date.now(),
        );
        resolve(result.applied);
        if (!result.applied || !result.history) return current;

        isDirtyRef.current = true;
        currentProjectRef.current = result.history.present;
        return result.history;
      });
    });

  const moveSection = (pageId: PageId, sectionId: string, direction: 'up' | 'down') => {
    if (!history?.present) return;
    const order = [...history.present.sectionOrder[pageId]];
    const idx = order.indexOf(sectionId);
    if (idx < 0) return;
    if (direction === 'up' && idx > 0)
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
    else if (direction === 'down' && idx < order.length - 1)
      [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
    else return;
    pushState({
      ...history.present,
      sectionOrder: { ...history.present.sectionOrder, [pageId]: order },
    });
  };

  const toggleSectionVisibility = (pageId: PageId, sectionId: string) => {
    if (!history?.present) return;
    const hidden = history.present.hiddenSections[pageId] || [];
    const isHidden = hidden.includes(sectionId);
    pushState({
      ...history.present,
      hiddenSections: {
        ...history.present.hiddenSections,
        [pageId]: isHidden
          ? hidden.filter(id => id !== sectionId)
          : [...hidden, sectionId],
      },
    });
  };

  const switchTemplate = (templateId: TemplateId) => {
    if (!history?.present || history.present.templateId === templateId) return;
    const template = TEMPLATES.find(item => item.id === templateId);
    if (!template) return;
    const current = history.present;
    const incompatibleSections = (Object.keys(current.pages) as PageId[]).flatMap(
      pageId => {
        const supportedTypes = template.supportedSections[pageId];
        return current.pages[pageId].sections.filter(
          s => !supportedTypes.includes(s.type),
        );
      },
    );
    if (
      incompatibleSections.length > 0 &&
      !window.confirm(
        `Switch to ${template.name}? ${incompatibleSections.length} section${incompatibleSections.length === 1 ? '' : 's'} not used by this template will be removed. Matching content and your business details will be kept.`,
      )
    )
      return;

    const pages = { ...current.pages };
    const sectionOrder = { ...current.sectionOrder };
    const hiddenSections = { ...current.hiddenSections };
    (Object.keys(pages) as PageId[]).forEach(pageId => {
      const supportedTypes = template.supportedSections[pageId];
      const sections = supportedTypes.map(
        type =>
          current.pages[pageId].sections.find(s => s.type === type) ||
          createDefaultSection(type),
      );
      pages[pageId] = { ...current.pages[pageId], sections };
      sectionOrder[pageId] = sections.map(s => s.id);
      hiddenSections[pageId] = hiddenSections[pageId].filter(id =>
        sections.some(s => s.id === id),
      );
    });
    pushState({
      ...current,
      templateId,
      designTokens: { ...template.defaultTokens },
      activePageId: template.supportedPages.includes(current.activePageId)
        ? current.activePageId
        : template.supportedPages[0],
      pages,
      sectionOrder,
      hiddenSections,
    });
  };

  const resetProject = () => {
    if (!history?.present) return;
    const current = history.present;
    const reset = createNewProject(current.name, current.templateId);
    pushState({ ...reset, id: current.id, name: current.name, createdAt: current.createdAt });
  };

  // ─── CRUD: switchProject ─────────────────────────────────────────────────
  const switchProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      if (history?.present?.id === projectId) return true;

      // Block switching while conflict is unresolved
      if (conflictState) {
        setMutationError('Resolve the save conflict before switching projects.');
        return false;
      }

      setMutationError(null);

      // Flush dirty draft before switching (wait for mutex)
      if (isDirtyRef.current) {
        const ok = await saveNow();
        if (!ok) return false;
      }

      const userId = userIdRef.current;
      if (!userId) return false;

      try {
        const record = await getWebsite(projectId);
        if (!mountedRef.current) return false;
        revisionMap.set(record.id, record.revision);
        setProjectSiteTypes(prev => ({ ...prev, [record.id]: record.siteType }));

        const cache = readCache(userId);
        const proj = recordToProject(record, cache);
        cache.set(record.id, proj);
        writeCache(userId, cache);
        writeActiveId(userId, proj.id);

        isDirtyRef.current = false;
        cleanFingerprintRef.current = stableFingerprint(proj);
        currentProjectRef.current = proj;
        setHistory({ past: [], present: proj, future: [] });
        setProjects(prev => prev.map(p => (p.id === proj.id ? proj : p)));
        return true;
      } catch (err) {
        setMutationError(`Failed to open project: ${extractErrorMessage(err)}`);
        return false;
      }
    },
    [history?.present?.id, conflictState, saveNow],
  );

  // ─── CRUD: newProject ─────────────────────────────────────────────────────
  const newProject = useCallback(
    async (name: string, templateId: string): Promise<boolean> => {
      setMutationError(null);
      const userId = userIdRef.current;
      if (!userId) {
        setMutationError('Not authenticated.');
        return false;
      }

      // Flush current dirty draft first
      if (isDirtyRef.current) {
        const ok = await saveNow();
        if (!ok) return false;
      }

      const proj = createNewProject(name, templateId);
      const currentProjects = projects;
      const updatedProjects = [...currentProjects, proj];
      if (!validateProjectCollection(proj, updatedProjects)) return false;

      try {
        const record = await createWebsite({
          id: proj.id,
          name: proj.name,
          projectSource: sanitizeProjectForServer(proj),
        });
        if (!mountedRef.current) return false;
        revisionMap.set(record.id, record.revision);
        setProjectSiteTypes(prev => ({ ...prev, [record.id]: record.siteType }));

        const cache = readCache(userId);
        const newProj = recordToProject(record, cache);
        cache.set(newProj.id, newProj);
        writeCache(userId, cache);
        writeActiveId(userId, newProj.id);

        isDirtyRef.current = false;
        cleanFingerprintRef.current = stableFingerprint(newProj);
        currentProjectRef.current = newProj;
        setProjects([...currentProjects, newProj]);
        setHistory({ past: [], present: newProj, future: [] });
        setSaveStatus('saved');
        return true;
      } catch (err) {
        setMutationError(`Failed to create project: ${extractErrorMessage(err)}`);
        return false;
      }
    },
    [projects, validateProjectCollection, saveNow],
  );

  // ─── CRUD: duplicateProject ───────────────────────────────────────────────
  const duplicateProject = useCallback(
    async (project: SiteProject): Promise<boolean> => {
      setMutationError(null);
      const userId = userIdRef.current;
      if (!userId) {
        setMutationError('Not authenticated.');
        return false;
      }

      // Flush dirty draft before duplicating (so server has latest content)
      if (isDirtyRef.current && currentProjectRef.current?.id === project.id) {
        const ok = await saveNow();
        if (!ok) return false;
      }

      const newName = `${project.name} (Copy)`;
      try {
        const record = await duplicateWebsite(project.id, { name: newName });
        if (!mountedRef.current) return false;
        revisionMap.set(record.id, record.revision);
        setProjectSiteTypes(prev => ({ ...prev, [record.id]: record.siteType }));

        const cache = readCache(userId);
        const dupProject = recordToProject(record, cache);
        const nextProjects = [...projects, dupProject];
        if (!validateProjectCollection(dupProject, nextProjects)) {
          void deleteWebsite(record.id).catch(() => {});
          return false;
        }
        cache.set(dupProject.id, dupProject);
        writeCache(userId, cache);
        writeActiveId(userId, dupProject.id);

        isDirtyRef.current = false;
        cleanFingerprintRef.current = stableFingerprint(dupProject);
        currentProjectRef.current = dupProject;
        setProjects(nextProjects);
        setHistory({ past: [], present: dupProject, future: [] });
        setSaveStatus('saved');
        return true;
      } catch (err) {
        setMutationError(`Failed to duplicate project: ${extractErrorMessage(err)}`);
        return false;
      }
    },
    [projects, validateProjectCollection, saveNow],
  );

  // ─── CRUD: deleteProject ─────────────────────────────────────────────────
  /**
   * Delete-last strategy (fix #8):
   * 1. Create a fresh replacement using createNewProject (fresh ID – never
   *    collides with the target even if target is the default seed).
   * 2. Only after replacement is confirmed on server: delete the target.
   * 3. If target delete fails: attempt to delete the replacement (rollback),
   *    restore UI to original state, return false with accurate error.
   * 4. Never show success or leave a hidden dangling server row.
   */
  const deleteProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      setMutationError(null);
      const userId = userIdRef.current;
      if (!userId) {
        setMutationError('Not authenticated.');
        return false;
      }

      const remaining = projects.filter(p => p.id !== projectId);

      if (remaining.length === 0) {
        // Create replacement FIRST with a fresh ID
        const replacement = createNewProject('My Project', 'home-services');
        let replacementRecord: WebsiteRecord;
        try {
          replacementRecord = await createWebsite({
            id: replacement.id,
            name: replacement.name,
            projectSource: sanitizeProjectForServer(replacement),
          });
          if (!mountedRef.current) return false;
        } catch (err) {
          if (!mountedRef.current) return false;
          setMutationError(
            `Could not create replacement project: ${extractErrorMessage(err)}. Original project retained.`,
          );
          return false;
        }

        // Now delete the target
        try {
          await deleteWebsite(projectId);
          if (!mountedRef.current) return false;
        } catch (deleteErr) {
          if (!mountedRef.current) return false;
          // Target delete failed – attempt to roll back the replacement
          try {
            await deleteWebsite(replacementRecord.id);
          } catch {
            // Rollback failed too – server has two rows now; surface detailed error
            setMutationError(
              `Delete failed (${extractErrorMessage(deleteErr)}) and replacement rollback also failed. Please contact support. Original project retained.`,
            );
            return false;
          }
          setMutationError(
            `Delete failed: ${extractErrorMessage(deleteErr)}. Original project retained.`,
          );
          return false;
        }

        revisionMap.delete(projectId);
        revisionMap.set(replacementRecord.id, replacementRecord.revision);
        setProjectSiteTypes(prev => {
          const next = { ...prev };
          delete next[projectId];
          next[replacementRecord.id] = replacementRecord.siteType;
          return next;
        });

        const cache = readCache(userId);
        cache.delete(projectId);
        const replacementProject = recordToProject(replacementRecord, cache);
        cache.set(replacementProject.id, replacementProject);
        writeCache(userId, cache);
        writeActiveId(userId, replacementProject.id);

        isDirtyRef.current = false;
        cleanFingerprintRef.current = stableFingerprint(replacementProject);
        currentProjectRef.current = replacementProject;
        setProjects([replacementProject]);
        setHistory({ past: [], present: replacementProject, future: [] });
        setSaveStatus('saved');
        return true;
      }

      // Normal delete (not last)
      try {
        await deleteWebsite(projectId);
        if (!mountedRef.current) return false;
      } catch (err) {
        setMutationError(`Failed to delete project: ${extractErrorMessage(err)}`);
        return false;
      }

      revisionMap.delete(projectId);
      setProjectSiteTypes(prev => {
        const next = { ...prev };
        delete next[projectId];
        return next;
      });

      const uid = userIdRef.current;
      if (uid) {
        const cache = readCache(uid);
        cache.delete(projectId);
        writeCache(uid, cache);
      }

      setProjects(remaining);
      if (history?.present?.id === projectId) {
        const next = remaining[0];
        isDirtyRef.current = false;
        cleanFingerprintRef.current = stableFingerprint(next);
        currentProjectRef.current = next;
        setHistory({ past: [], present: next, future: [] });
        if (uid) writeActiveId(uid, next.id);
      }
      setSaveStatus('saved');
      return true;
    },
    [projects, history?.present?.id],
  );

  // ─── CRUD: renameProject ─────────────────────────────────────────────────
  /**
   * Rename with optimistic concurrency:
   *
   * - Sends { name, expectedRevision } so the backend can reject a stale rename.
   * - On success: update revisionMap with the new revision returned by the server.
   *   If the active draft is dirty the dirty flag is left alone so the pending
   *   PUT will carry both the new name and the unsaved content edits.
   *   If the draft is clean, update the clean fingerprint to the new name so no
   *   ghost debounce PUT fires.
   * - On 409: update revisionMap from the conflict data so the next save attempt
   *   uses the correct revision. Only set conflictState (which blocks the editor)
   *   when the renamed project is the currently active one AND we can offer a
   *   coherent "load server / keep mine" choice. For inactive projects or
   *   incoherent 409 data, surface a clear mutationError without touching local
   *   state – the user can retry or reopen.
   * - Never mutates local project state on a failed rename.
   */
  const renameProject = useCallback(
    async (projectId: string, newName: string): Promise<boolean> => {
      const nextName = newName.trim();
      if (!nextName) return false;
      setMutationError(null);
      const userId = userIdRef.current;
      if (!userId) {
        setMutationError('Not authenticated.');
        return false;
      }

      const expectedRevision = revisionMap.get(projectId) ?? 0;
      // Cast is safe: the backend already accepts this field; codegen will catch up.
      const body = buildRenameBody(nextName, expectedRevision) as unknown as WebsiteRenameWithRevision;

      let record: WebsiteRecord;
      try {
        record = await renameWebsite(projectId, body as Parameters<typeof renameWebsite>[1]);
        if (!mountedRef.current) return false;
      } catch (err) {
        if (!mountedRef.current) return false;

        // ── 409 rename conflict ────────────────────────────────────────────
        const conflict = extractRenameConflict(err);
        if (conflict) {
          // Always update revisionMap so the next PUT uses the correct revision.
          revisionMap.set(projectId, conflict.serverRevision);

          const isActiveProject = currentProjectRef.current?.id === projectId;

          if (isActiveProject) {
            // We can offer a coherent conflict resolution only for the active project.
            // Merge the active draft's local ownerKey into the server version so
            // "load server" doesn't erase a local-only secret.
            const serverWithKey = mergeLocalOwnerKey(
              conflict.serverProject,
              currentProjectRef.current ?? undefined,
            );

            setConflictState({
              serverId: projectId,
              serverRevision: conflict.serverRevision,
              serverProject: serverWithKey,
              // localDraft captures the live state at conflict time
              localDraft: currentProjectRef.current!,
            });
            setSaveStatus('conflict');
            // Recoverable – user sees the conflict banner with both choices
            setMutationError(
              `Rename conflict: the project was modified elsewhere (revision out of date). ` +
              `Choose "Load server version" or "Keep my edits" to resolve.`,
            );
          } else {
            // Inactive project: we can't offer a rich UI choice right now.
            // Surface as a plain recoverable error; local state is untouched.
            setMutationError(
              `Could not rename "${nextName}": revision conflict with the server. ` +
              `Switch to this project and resolve the conflict, then retry.`,
            );
          }
          return false;
        }

        // ── Other error ────────────────────────────────────────────────────
        setMutationError(`Failed to rename project: ${extractErrorMessage(err)}`);
        return false;
      }

      // ── Success path ───────────────────────────────────────────────────────
      revisionMap.set(record.id, record.revision);

      // Canonical name from DB row
      const canonicalName = record.name;

      const cache = readCache(userId);
      const cachedProject = cache.get(projectId);
      const updatedCached: SiteProject = cachedProject
        ? { ...cachedProject, name: canonicalName, updatedAt: Date.now() }
        : { ...(record.projectSource as SiteProject), name: canonicalName };
      cache.set(projectId, updatedCached);
      writeCache(userId, cache);

      // Update history.present if this is the active project
      if (currentProjectRef.current?.id === projectId) {
        const updatedPresent: SiteProject = {
          ...currentProjectRef.current,
          name: canonicalName,
        };
        currentProjectRef.current = updatedPresent;
        setHistory(curr => {
          if (!curr || curr.present.id !== projectId) return curr;
          return { ...curr, present: updatedPresent };
        });

        // Only update clean fingerprint when draft is clean, so no ghost PUT fires.
        // If dirty: leave isDirtyRef and cleanFingerprintRef alone; the debounce
        // PUT will carry both the new name and the unsaved edits.
        if (!isDirtyRef.current) {
          cleanFingerprintRef.current = stableFingerprint(updatedPresent);
        }
      }

      setProjects(prev =>
        prev.map(p =>
          p.id === projectId ? { ...p, name: canonicalName, updatedAt: Date.now() } : p,
        ),
      );
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ─── Return ───────────────────────────────────────────────────────────────
  return {
    isReady,
    initError,
    retryInitialization,
    project: history?.present,
    projectSiteType: history?.present ? projectSiteTypes[history.present.id] : null,
    projectSiteTypes,
    projects,
    saveStatus,
    saveError,
    conflictState,
    mutationError,
    saveNow,
    retrySave,
    resolveConflictLoadServer,
    resolveConflictOverwrite,
    undo,
    redo,
    canUndo: history ? history.past.length > 0 : false,
    canRedo: history ? history.future.length > 0 : false,
    updateBusiness,
    updateTokens,
    updateReceptionist,
    setActivePage,
    updateSection,
    applyBriefDraft,
    moveSection,
    toggleSectionVisibility,
    switchTemplate,
    resetProject,
    switchProject,
    newProject,
    renameProject,
    duplicateProject,
    deleteProject,
  };
}
