/**
 * Pure unit tests for SiteForge Studio persistence helpers.
 *
 * Tests import from the PRODUCTION module (studio-persistence-helpers.ts)
 * – not inline mirrors – so regressions in the real code are caught here.
 *
 * Run with (no bundler needed; tsx handles TypeScript):
 *   artifacts/siteforge-studio/node_modules/.bin/tsx --test \
 *     artifacts/siteforge-studio/src/hooks/use-studio-helpers.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Import from the REAL production helpers ──────────────────────────────────
import {
  LEGACY_STORAGE_KEY,
  PILOT_RETELL_AGENT_ID,
  SERVER_CREDENTIAL_KEYS,
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

import type { SiteProject, ReceptionistConfig } from '../lib/types';
import type { WebsiteImportResult } from '@workspace/api-client-react';

// ─── localStorage stub for Node (no DOM) ─────────────────────────────────────
const localStorageStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => localStorageStore[k] ?? null,
  setItem: (k: string, v: string) => { localStorageStore[k] = v; },
  removeItem: (k: string) => { delete localStorageStore[k]; },
  clear: () => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); },
};
// Patch global for Node
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

// ─── Fixtures ─────────────────────────────────────────────────────────────────
function makeProject(overrides: Partial<SiteProject> = {}): SiteProject {
  return {
    id: 'test-id',
    name: 'Test Project',
    createdAt: 1000000,
    updatedAt: 1000001,
    activePageId: 'home',
    templateId: 'home-services',
    designTokens: {
      primaryColor: '#ef5d3f',
      fontHeading: 'Manrope',
      fontBody: 'Inter',
      borderRadius: 'lg',
      buttonStyle: 'solid',
    },
    business: {
      name: 'Test Biz',
      category: 'Services',
      city: 'Toronto',
      phone: '416-555-0000',
      email: 'test@example.com',
    },
    pages: {
      home: { id: 'home', name: 'Home', sections: [] },
      about: { id: 'about', name: 'About', sections: [] },
      services: { id: 'services', name: 'Services', sections: [] },
      contact: { id: 'contact', name: 'Contact', sections: [] },
    },
    sectionOrder: { home: [], about: [], services: [], contact: [] },
    hiddenSections: { home: [], about: [], services: [], contact: [] },
    ...overrides,
  };
}

function makeImportResult(overrides: Partial<WebsiteImportResult> = {}): WebsiteImportResult {
  return {
    results: [],
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    ...overrides,
  };
}

// ─── 1. Constants ─────────────────────────────────────────────────────────────
describe('Constants', () => {
  it('LEGACY_STORAGE_KEY is siteforge_projects', () => {
    assert.equal(LEGACY_STORAGE_KEY, 'siteforge_projects');
  });
  it('PILOT_RETELL_AGENT_ID matches expected value', () => {
    assert.equal(PILOT_RETELL_AGENT_ID, 'agent_3e4f5dc655300344ba25df50f8');
  });

  // Fix #1: ownerKey and other true secrets are in the set
  it('SERVER_CREDENTIAL_KEYS includes ownerKey', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('ownerKey'));
  });
  it('SERVER_CREDENTIAL_KEYS includes ownerKeyHash', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('ownerKeyHash'));
  });
  it('SERVER_CREDENTIAL_KEYS includes setupKey', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('setupKey'));
  });
  it('SERVER_CREDENTIAL_KEYS includes secretKey', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('secretKey'));
  });
  it('SERVER_CREDENTIAL_KEYS includes apiKey', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('apiKey'));
  });
  it('SERVER_CREDENTIAL_KEYS includes apiSecret', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('apiSecret'));
  });
  it('SERVER_CREDENTIAL_KEYS includes webhookSecret', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('webhookSecret'));
  });
  it('SERVER_CREDENTIAL_KEYS includes password', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('password'));
  });
  it('SERVER_CREDENTIAL_KEYS includes token', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('token'));
  });
  it('SERVER_CREDENTIAL_KEYS includes accessToken', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('accessToken'));
  });
  it('SERVER_CREDENTIAL_KEYS includes refreshToken', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('refreshToken'));
  });
  it('SERVER_CREDENTIAL_KEYS includes privateKey', () => {
    assert.ok(SERVER_CREDENTIAL_KEYS.has('privateKey'));
  });

  // Fix #1: hostedApiUrl and provisionedAt are NOT credentials – must be retained
  it('SERVER_CREDENTIAL_KEYS does NOT include hostedApiUrl', () => {
    assert.ok(!SERVER_CREDENTIAL_KEYS.has('hostedApiUrl'), 'hostedApiUrl is schema-defined, not a secret');
  });
  it('SERVER_CREDENTIAL_KEYS does NOT include provisionedAt', () => {
    assert.ok(!SERVER_CREDENTIAL_KEYS.has('provisionedAt'), 'provisionedAt is schema-defined, not a secret');
  });
});

// ─── 2. Scoped localStorage keys ─────────────────────────────────────────────
describe('Scoped localStorage keys', () => {
  it('active key contains userId and starts with siteforge_', () => {
    const key = scopedActiveKey('user-abc');
    assert.ok(key.includes('user-abc'));
    assert.ok(key.startsWith('siteforge_'));
  });
  it('cache key contains userId', () => {
    assert.ok(scopedCacheKey('user-xyz').includes('user-xyz'));
  });
  it('migration key contains userId', () => {
    assert.ok(scopedMigrationKey('user-123').includes('user-123'));
  });
  it('different users produce different keys', () => {
    assert.notEqual(scopedActiveKey('alice'), scopedActiveKey('bob'));
    assert.notEqual(scopedCacheKey('alice'), scopedCacheKey('bob'));
    assert.notEqual(scopedMigrationKey('alice'), scopedMigrationKey('bob'));
  });
  it('same user always produces the same key', () => {
    assert.equal(scopedActiveKey('alice'), scopedActiveKey('alice'));
    assert.equal(scopedCacheKey('alice'), scopedCacheKey('alice'));
  });
});

// ─── 3. sanitizeProjectForServer ─────────────────────────────────────────────
describe('sanitizeProjectForServer – credential stripping', () => {
  // Basic secret removal
  it('strips ownerKey from receptionist', () => {
    const p = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'Aria',
        ownerKey: 'sk-secret',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const s = sanitizeProjectForServer(p);
    assert.ok(!('ownerKey' in (s.receptionist as object)));
    assert.equal((s.receptionist as ReceptionistConfig).assistantName, 'Aria');
  });

  it('strips all credential keys in one pass', () => {
    const p = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'All',
        ownerKey: 'a',
        ownerKeyHash: 'b',
        setupKey: 'c',
        secretKey: 'd',
        apiKey: 'e',
        apiSecret: 'f',
        webhookSecret: 'g',
        password: 'h',
        token: 'i',
        accessToken: 'j',
        refreshToken: 'k',
        privateKey: 'l',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as unknown as ReceptionistConfig,
    });
    const s = sanitizeProjectForServer(p);
    const rec = s.receptionist as Record<string, unknown>;
    for (const key of SERVER_CREDENTIAL_KEYS) {
      assert.ok(!(key in rec), `${key} must be stripped`);
    }
    assert.equal(rec.assistantName, 'All');
  });

  // Fix #1: hostedApiUrl and provisionedAt MUST be retained
  it('retains hostedApiUrl (non-secret schema field)', () => {
    const p = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'Bot',
        hostedApiUrl: 'https://api.example.com/widget',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig,
    });
    const s = sanitizeProjectForServer(p);
    assert.equal(
      (s.receptionist as ReceptionistConfig).hostedApiUrl,
      'https://api.example.com/widget',
      'hostedApiUrl must survive sanitization',
    );
  });

  it('retains provisionedAt (non-secret schema field)', () => {
    const p = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'Bot',
        provisionedAt: 1700000000,
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig,
    });
    const s = sanitizeProjectForServer(p);
    assert.equal(
      (s.receptionist as ReceptionistConfig).provisionedAt,
      1700000000,
      'provisionedAt must survive sanitization',
    );
  });

  it('retains both hostedApiUrl and provisionedAt together', () => {
    const p = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'Bot',
        hostedApiUrl: 'https://x',
        provisionedAt: 999,
        ownerKey: 'secret',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const s = sanitizeProjectForServer(p);
    const rec = s.receptionist as ReceptionistConfig & { ownerKey?: string };
    assert.equal(rec.hostedApiUrl, 'https://x');
    assert.equal(rec.provisionedAt, 999);
    assert.ok(!('ownerKey' in rec), 'ownerKey still stripped');
  });

  // Fix #1: actual recursion through nested objects
  it('recursively strips credentials from deeply nested objects', () => {
    // We put a credential inside a nested object within receptionist
    const p = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'Deep',
        retellAgentId: PILOT_RETELL_AGENT_ID,
        nested: {
          ownerKey: 'should-be-gone',
          apiKey: 'also-gone',
          safeField: 'keep-me',
        },
      } as unknown as ReceptionistConfig,
    });
    const s = sanitizeProjectForServer(p);
    const nested = (s.receptionist as unknown as { nested: Record<string, unknown> }).nested;
    assert.ok(!('ownerKey' in nested), 'ownerKey must be stripped from nested object');
    assert.ok(!('apiKey' in nested), 'apiKey must be stripped from nested object');
    assert.equal(nested.safeField, 'keep-me', 'safe nested field preserved');
  });

  it('recursively strips credentials from arrays of objects', () => {
    const p = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'ArrayTest',
        retellAgentId: PILOT_RETELL_AGENT_ID,
        items: [
          { ownerKey: 'gone', label: 'keep1' },
          { secretKey: 'gone', label: 'keep2' },
        ],
      } as unknown as ReceptionistConfig,
    });
    const s = sanitizeProjectForServer(p);
    const items = (s.receptionist as unknown as { items: Array<Record<string, unknown>> }).items;
    assert.equal(items.length, 2, 'array length preserved');
    assert.ok(!('ownerKey' in items[0]), 'ownerKey stripped from array element');
    assert.ok(!('secretKey' in items[1]), 'secretKey stripped from array element');
    assert.equal(items[0].label, 'keep1', 'safe array field preserved');
    assert.equal(items[1].label, 'keep2', 'safe array field preserved');
  });

  it('does not modify the original project object', () => {
    const rec = {
      enabled: true,
      assistantName: 'Orig',
      ownerKey: 'keep-in-original',
      retellAgentId: PILOT_RETELL_AGENT_ID,
    } as ReceptionistConfig & { ownerKey: string };
    const p = makeProject({ receptionist: rec });
    sanitizeProjectForServer(p);
    assert.equal((p.receptionist as typeof rec).ownerKey, 'keep-in-original');
  });

  it('returns project unchanged when no receptionist', () => {
    const p = makeProject({ receptionist: undefined });
    assert.deepEqual(sanitizeProjectForServer(p), p);
  });

  it('preserves non-credential receptionist fields', () => {
    const p = makeProject({
      receptionist: {
        enabled: false,
        assistantName: 'Bob',
        greeting: 'Hello',
        knowledge: 'Some text',
        hostedApiUrl: 'https://url',
        provisionedAt: 123,
        retellAgentId: PILOT_RETELL_AGENT_ID,
        ownerKey: 'strip-me',
      } as ReceptionistConfig & { ownerKey: string },
    });
    const s = sanitizeProjectForServer(p);
    const rec = s.receptionist as ReceptionistConfig & { ownerKey?: string };
    assert.equal(rec.greeting, 'Hello');
    assert.equal(rec.knowledge, 'Some text');
    assert.equal(rec.hostedApiUrl, 'https://url');
    assert.equal(rec.provisionedAt, 123);
    assert.ok(!('ownerKey' in rec));
  });
});

// ─── 4. stableFingerprint ─────────────────────────────────────────────────────
describe('stableFingerprint', () => {
  // Fix #3: full JSON, so same-ms edits with different content differ
  it('produces different fingerprints for projects differing only in section content', () => {
    const base = makeProject({
      id: 'proj-1',
      name: 'Proj',
      updatedAt: 5000000, // same ms
      pages: {
        home: {
          id: 'home',
          name: 'Home',
          sections: [{ id: 'hero', type: 'hero', headline: 'Version A' } as unknown as import('../lib/types').SectionData],
        },
        about: { id: 'about', name: 'About', sections: [] },
        services: { id: 'services', name: 'Services', sections: [] },
        contact: { id: 'contact', name: 'Contact', sections: [] },
      },
    });
    const modified = {
      ...base,
      pages: {
        ...base.pages,
        home: {
          ...base.pages.home,
          sections: [{ id: 'hero', type: 'hero', headline: 'Version B' } as unknown as import('../lib/types').SectionData],
        },
      },
    };

    const fpA = stableFingerprint(base);
    const fpB = stableFingerprint(modified);
    assert.notEqual(fpA, fpB, 'fingerprint must differ when section content differs even with same id/name/updatedAt');
  });

  it('produces the same fingerprint for identical projects', () => {
    const p1 = makeProject({ id: 'x', name: 'Same', updatedAt: 9999 });
    const p2 = makeProject({ id: 'x', name: 'Same', updatedAt: 9999 });
    assert.equal(stableFingerprint(p1), stableFingerprint(p2));
  });

  it('produces different fingerprints when name changes', () => {
    const p1 = makeProject({ id: 'x', name: 'A', updatedAt: 9999 });
    const p2 = makeProject({ id: 'x', name: 'B', updatedAt: 9999 });
    assert.notEqual(stableFingerprint(p1), stableFingerprint(p2));
  });

  it('produces different fingerprints when updatedAt changes', () => {
    const p1 = makeProject({ id: 'x', name: 'Same', updatedAt: 1 });
    const p2 = makeProject({ id: 'x', name: 'Same', updatedAt: 2 });
    assert.notEqual(stableFingerprint(p1), stableFingerprint(p2));
  });

  it('strips credentials before fingerprinting so ownerKey fluctuation is invisible', () => {
    const p1 = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'key-v1',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const p2 = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'key-v2', // different ownerKey
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    assert.equal(
      stableFingerprint(p1),
      stableFingerprint(p2),
      'ownerKey difference must not affect fingerprint (it is stripped)',
    );
  });

  it('detects changes to hostedApiUrl (non-secret, part of fingerprint)', () => {
    const p1 = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'A',
        hostedApiUrl: 'https://old',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig,
    });
    const p2 = makeProject({
      receptionist: {
        enabled: true,
        assistantName: 'A',
        hostedApiUrl: 'https://new',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig,
    });
    assert.notEqual(
      stableFingerprint(p1),
      stableFingerprint(p2),
      'hostedApiUrl is retained in fingerprint',
    );
  });
});

// ─── 5. mergeLocalOwnerKey ────────────────────────────────────────────────────
describe('mergeLocalOwnerKey', () => {
  it('merges ownerKey when IDs match and server has receptionist', () => {
    const server = makeProject({
      id: 'proj-1',
      receptionist: { enabled: true, assistantName: 'A', retellAgentId: PILOT_RETELL_AGENT_ID },
    });
    const cached = makeProject({
      id: 'proj-1',
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'secret',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const merged = mergeLocalOwnerKey(server, cached);
    assert.equal(
      (merged.receptionist as ReceptionistConfig & { ownerKey?: string })?.ownerKey,
      'secret',
    );
  });

  it('does NOT merge ownerKey from a different project ID', () => {
    const server = makeProject({
      id: 'proj-1',
      receptionist: { enabled: true, assistantName: 'A', retellAgentId: PILOT_RETELL_AGENT_ID },
    });
    const cached = makeProject({
      id: 'proj-2',
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'wrong-project',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const merged = mergeLocalOwnerKey(server, cached);
    assert.ok(!('ownerKey' in (merged.receptionist as object)));
  });

  it('returns server project unchanged when cached is undefined', () => {
    const server = makeProject({ id: 'proj-1' });
    assert.deepEqual(mergeLocalOwnerKey(server, undefined), server);
  });

  it('returns server project unchanged when server has no receptionist', () => {
    const server = makeProject({ id: 'proj-1', receptionist: undefined });
    const cached = makeProject({
      id: 'proj-1',
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'key',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    assert.deepEqual(mergeLocalOwnerKey(server, cached), server);
  });

  it('returns server project unchanged when cached has no ownerKey', () => {
    const server = makeProject({
      id: 'proj-1',
      receptionist: { enabled: true, assistantName: 'A', retellAgentId: PILOT_RETELL_AGENT_ID },
    });
    const cached = makeProject({
      id: 'proj-1',
      receptionist: { enabled: true, assistantName: 'A', retellAgentId: PILOT_RETELL_AGENT_ID },
    });
    assert.deepEqual(mergeLocalOwnerKey(server, cached), server);
  });
});

// ─── 6. readLegacyProjects ────────────────────────────────────────────────────
describe('readLegacyProjects', () => {
  beforeEach(() => localStorageStub.clear());

  it('returns empty array when key absent', () => {
    assert.deepEqual(readLegacyProjects(), []);
  });

  it('returns parsed projects and does not remove or mutate the stored value', () => {
    const original = [makeProject({ id: 'abc' })];
    localStorageStub.setItem(LEGACY_STORAGE_KEY, JSON.stringify(original));
    const result = readLegacyProjects();
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'abc');
    const raw = localStorageStub.getItem(LEGACY_STORAGE_KEY);
    assert.ok(raw, 'key must still exist after read');
    assert.deepEqual(JSON.parse(raw!)[0].id, 'abc');
  });

  it('returns empty array on malformed JSON', () => {
    localStorageStub.setItem(LEGACY_STORAGE_KEY, '{not-json}}}');
    assert.deepEqual(readLegacyProjects(), []);
  });

  it('returns empty array when stored value is not an array', () => {
    localStorageStub.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ foo: 'bar' }));
    assert.deepEqual(readLegacyProjects(), []);
  });
});

// ─── 7. applyLocalMigrations ──────────────────────────────────────────────────
describe('applyLocalMigrations', () => {
  it('filters out retired Northline project by business name', () => {
    const good = makeProject({ id: 'good' });
    const nl = makeProject({ id: 'bad', business: { ...makeProject().business, name: 'Northline Services' } });
    const result = applyLocalMigrations([good, nl]);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'good');
  });

  it('filters out retired Northline project by email', () => {
    const nl = makeProject({ id: 'bad', business: { ...makeProject().business, email: 'hello@northline.ca' } });
    assert.equal(applyLocalMigrations([nl]).length, 0);
  });

  it('applies receptionist defaults when absent', () => {
    const p = makeProject({ receptionist: undefined });
    const [result] = applyLocalMigrations([p]);
    assert.ok(result.receptionist);
    assert.equal(result.receptionist?.retellAgentId, PILOT_RETELL_AGENT_ID);
    assert.equal(result.receptionist?.enabled, false);
    assert.equal(result.receptionist?.assistantName, 'Assistant');
  });

  it('forces retellAgentId to pilot value even if wrong', () => {
    const p = makeProject({ receptionist: { enabled: true, assistantName: 'Old', retellAgentId: 'wrong' } });
    const [result] = applyLocalMigrations([p]);
    assert.equal(result.receptionist?.retellAgentId, PILOT_RETELL_AGENT_ID);
  });

  it('does not mutate the input array', () => {
    const orig = [makeProject({ id: 'a', receptionist: undefined })];
    const snap = JSON.stringify(orig);
    applyLocalMigrations(orig);
    assert.equal(JSON.stringify(orig), snap);
  });
});

// ─── 8. isImportable ─────────────────────────────────────────────────────────
describe('isImportable', () => {
  it('valid project passes', () => { assert.ok(isImportable(makeProject())); });
  it('rejects empty id', () => { assert.ok(!isImportable(makeProject({ id: '' }))); });
  it('rejects empty name', () => { assert.ok(!isImportable(makeProject({ name: '' }))); });
  it('rejects non-number createdAt', () => {
    const p = makeProject();
    (p as unknown as { createdAt: string }).createdAt = 'not-a-number';
    assert.ok(!isImportable(p));
  });
  it('rejects missing pages', () => {
    const p = makeProject();
    delete (p as unknown as { pages?: unknown }).pages;
    assert.ok(!isImportable(p));
  });
  it('rejects missing designTokens', () => {
    const p = makeProject();
    delete (p as unknown as { designTokens?: unknown }).designTokens;
    assert.ok(!isImportable(p));
  });
});

// ─── 9. isMigrationComplete ───────────────────────────────────────────────────
describe('isMigrationComplete – strict per-item status check (fix #2)', () => {
  // Helper: build result.results array
  function items(statuses: string[]): Array<{ id: string; status: string }> {
    return statuses.map((status, i) => ({ id: `item-${i}`, status }));
  }

  it('complete: all imported, count matches, errors=0', () => {
    const result = makeImportResult({
      results: items(['imported', 'imported', 'imported']),
      imported: 3,
      skipped: 0,
      errors: 0,
    });
    assert.ok(isMigrationComplete(result, 3));
  });

  it('complete: mix of imported and skipped, count matches', () => {
    const result = makeImportResult({
      results: items(['imported', 'skipped', 'skipped']),
      imported: 1,
      skipped: 2,
      errors: 0,
    });
    assert.ok(isMigrationComplete(result, 3));
  });

  it('complete: all skipped', () => {
    const result = makeImportResult({
      results: items(['skipped', 'skipped']),
      imported: 0,
      skipped: 2,
      errors: 0,
    });
    assert.ok(isMigrationComplete(result, 2));
  });

  it('complete: zero items submitted', () => {
    assert.ok(isMigrationComplete(makeImportResult(), 0));
  });

  // Fix #2: 'updated' status must be rejected
  it('REJECTED: any item has status updated', () => {
    const result = makeImportResult({
      results: items(['imported', 'updated']),
      imported: 1,
      updated: 1,
      errors: 0,
    });
    assert.ok(!isMigrationComplete(result, 2), "'updated' status must be rejected");
  });

  it('REJECTED: all items updated', () => {
    const result = makeImportResult({
      results: items(['updated', 'updated']),
      imported: 0,
      updated: 2,
      errors: 0,
    });
    assert.ok(!isMigrationComplete(result, 2));
  });

  it('REJECTED: errors > 0', () => {
    const result = makeImportResult({
      results: items(['imported', 'imported']),
      imported: 2,
      errors: 1,
    });
    assert.ok(!isMigrationComplete(result, 2));
  });

  it('REJECTED: result count fewer than submitted', () => {
    const result = makeImportResult({
      results: items(['imported', 'imported']),
      imported: 2,
      errors: 0,
    });
    assert.ok(!isMigrationComplete(result, 3));
  });

  it('REJECTED: result count more than submitted', () => {
    const result = makeImportResult({
      results: items(['imported', 'imported', 'imported', 'imported']),
      imported: 4,
      errors: 0,
    });
    assert.ok(!isMigrationComplete(result, 3));
  });

  it('REJECTED: aggregate counts disagree with submittedCount', () => {
    // results array length == 3, but imported+skipped == 2 (liar server)
    const result = makeImportResult({
      results: items(['imported', 'skipped', 'imported']),
      imported: 1,
      skipped: 1,
      errors: 0,
    });
    assert.ok(!isMigrationComplete(result, 3), 'aggregate must also match');
  });
});

// ─── 10. isApiError / extractErrorMessage ─────────────────────────────────────
describe('isApiError', () => {
  it('identifies object with numeric status', () => {
    assert.ok(isApiError({ status: 409, data: null }));
  });
  it('rejects plain Error', () => {
    assert.ok(!isApiError(new Error('x')));
  });
  it('rejects null', () => {
    assert.ok(!isApiError(null));
  });
  it('rejects string', () => {
    assert.ok(!isApiError('err'));
  });
  it('rejects object without status', () => {
    assert.ok(!isApiError({ message: 'no status' }));
  });
});

describe('extractErrorMessage', () => {
  it('extracts message from Error', () => {
    assert.equal(extractErrorMessage(new Error('boom')), 'boom');
  });
  it('extracts data.error string from API error', () => {
    assert.equal(extractErrorMessage({ status: 400, data: { error: 'Bad request' } }), 'Bad request');
  });
  it('falls back to HTTP status when data.error absent', () => {
    assert.equal(extractErrorMessage({ status: 503, data: null }), 'HTTP 503');
  });
  it('handles null gracefully', () => {
    assert.equal(extractErrorMessage(null), 'Unknown error');
  });
  it('handles undefined gracefully', () => {
    assert.equal(extractErrorMessage(undefined), 'Unknown error');
  });
  it('stringifies unknown values', () => {
    assert.equal(extractErrorMessage('raw string'), 'raw string');
  });
});

// ─── 11. buildRenameBody ──────────────────────────────────────────────────────
describe('buildRenameBody', () => {
  it('includes name and expectedRevision', () => {
    const body = buildRenameBody('My Site', 7);
    assert.equal(body.name, 'My Site');
    assert.equal(body.expectedRevision, 7);
  });

  it('trims whitespace from name', () => {
    const body = buildRenameBody('  Trimmed  ', 0);
    assert.equal(body.name, 'Trimmed');
  });

  it('accepts revision 0 (first save)', () => {
    const body = buildRenameBody('Zero', 0);
    assert.equal(body.expectedRevision, 0);
  });

  it('produces a plain object with exactly the expected keys', () => {
    const body = buildRenameBody('Keys', 3);
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ['expectedRevision', 'name']);
  });

  it('does not mutate across calls', () => {
    const a = buildRenameBody('A', 1);
    const b = buildRenameBody('B', 2);
    assert.equal(a.name, 'A');
    assert.equal(b.name, 'B');
  });
});

// ─── 12. extractRenameConflict ────────────────────────────────────────────────
describe('extractRenameConflict', () => {
  // Helper: build a fake WebsiteRecord payload
  function makeRecord(overrides: {
    id?: string;
    name?: string;
    revision?: number;
    projectSourceName?: string;
  } = {}) {
    return {
      id: overrides.id ?? 'proj-1',
      name: overrides.name ?? 'Server Name',
      revision: overrides.revision ?? 5,
      status: 'active',
      schemaVersion: 1,
      projectSource: makeProject({ id: overrides.id ?? 'proj-1', name: overrides.projectSourceName ?? 'Server Name' }),
      settings: {},
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };
  }

  it('returns null for non-409 API errors', () => {
    assert.equal(extractRenameConflict({ status: 500, data: { error: 'Server error' } }), null);
    assert.equal(extractRenameConflict({ status: 400, data: { error: 'Bad request' } }), null);
  });

  it('returns null for non-API errors', () => {
    assert.equal(extractRenameConflict(new Error('network')), null);
    assert.equal(extractRenameConflict(null), null);
    assert.equal(extractRenameConflict('string'), null);
  });

  it('returns null for 409 without data.current', () => {
    assert.equal(extractRenameConflict({ status: 409, data: null }), null);
    assert.equal(extractRenameConflict({ status: 409, data: { error: 'conflict' } }), null);
    assert.equal(extractRenameConflict({ status: 409, data: { current: null } }), null);
  });

  it('extracts serverRevision from a coherent 409', () => {
    const record = makeRecord({ revision: 12 });
    const result = extractRenameConflict({ status: 409, data: { current: record } });
    assert.ok(result !== null);
    assert.equal(result!.serverRevision, 12);
  });

  it('overlays canonical record.name onto serverProject when it differs from projectSource', () => {
    const record = makeRecord({ name: 'Canonical Name', projectSourceName: 'Stale Name' });
    const result = extractRenameConflict({ status: 409, data: { current: record } });
    assert.ok(result !== null);
    assert.equal(result!.serverProject.name, 'Canonical Name');
  });

  it('leaves serverProject.name unchanged when record.name matches projectSource', () => {
    const record = makeRecord({ name: 'Same Name', projectSourceName: 'Same Name' });
    const result = extractRenameConflict({ status: 409, data: { current: record } });
    assert.ok(result !== null);
    assert.equal(result!.serverProject.name, 'Same Name');
  });

  it('serverProject has the same id as the record', () => {
    const record = makeRecord({ id: 'proj-abc', name: 'Proj' });
    const result = extractRenameConflict({ status: 409, data: { current: record } });
    assert.ok(result !== null);
    assert.equal(result!.serverProject.id, 'proj-abc');
  });
});

// ─── 13. resolveConflictOverwrite – live draft vs snapshot selection ──────────
describe('resolveConflictOverwrite – live draft selection logic (pure invariant tests)', () => {
  /**
   * These tests verify the pure selection logic in isolation:
   * "use live draft when IDs match; fall back to snapshot otherwise".
   * They mirror the branch logic inside resolveConflictOverwrite without
   * involving React state.
   */

  function selectDraftToSave(
    liveProject: SiteProject | null,
    snapshot: SiteProject,
    conflictServerId: string,
  ): SiteProject {
    if (liveProject && liveProject.id === conflictServerId) {
      // Re-merge ownerKey from snapshot in case it is only stored there
      return mergeLocalOwnerKey(liveProject, snapshot);
    }
    return snapshot;
  }

  it('uses live draft when its ID matches the conflict server ID', () => {
    const snap = makeProject({ id: 'proj-1', name: 'Snapshot' });
    const live = makeProject({ id: 'proj-1', name: 'Live Draft' });
    const selected = selectDraftToSave(live, snap, 'proj-1');
    assert.equal(selected.name, 'Live Draft');
  });

  it('falls back to snapshot when live project has a different ID (switched away)', () => {
    const snap = makeProject({ id: 'proj-1', name: 'Snapshot' });
    const live = makeProject({ id: 'proj-2', name: 'Different Project' });
    const selected = selectDraftToSave(live, snap, 'proj-1');
    assert.equal(selected.name, 'Snapshot');
  });

  it('falls back to snapshot when live project is null', () => {
    const snap = makeProject({ id: 'proj-1', name: 'Snapshot' });
    const selected = selectDraftToSave(null, snap, 'proj-1');
    assert.equal(selected.name, 'Snapshot');
  });

  it('merges ownerKey from snapshot into live draft when live draft lacks it', () => {
    const snap = makeProject({
      id: 'proj-1',
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'secret-from-snapshot',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const live = makeProject({
      id: 'proj-1',
      name: 'Live',
      receptionist: {
        enabled: true,
        assistantName: 'A',
        retellAgentId: PILOT_RETELL_AGENT_ID,
        // no ownerKey – it was only in the snapshot
      },
    });
    const selected = selectDraftToSave(live, snap, 'proj-1');
    assert.equal(selected.name, 'Live', 'live draft content is preserved');
    assert.equal(
      (selected.receptionist as ReceptionistConfig & { ownerKey?: string })?.ownerKey,
      'secret-from-snapshot',
      'ownerKey is merged from snapshot',
    );
  });

  it('snapshot ownerKey wins when mergeLocalOwnerKey is applied (snapshot is the cache source)', () => {
    // mergeLocalOwnerKey(serverProject=live, cachedProject=snap) always injects
    // cachedProject.ownerKey into serverProject regardless of whether serverProject
    // already has one. The snapshot is authoritative for the secret because it
    // was the last version saved to localStorage.
    const snap = makeProject({
      id: 'proj-1',
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'snapshot-key',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const live = makeProject({
      id: 'proj-1',
      name: 'Live',
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'live-key', // would be overwritten by mergeLocalOwnerKey
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const selected = selectDraftToSave(live, snap, 'proj-1');
    // mergeLocalOwnerKey(live, snap) → injects snap.ownerKey → 'snapshot-key'
    assert.equal(
      (selected.receptionist as ReceptionistConfig & { ownerKey?: string })?.ownerKey,
      'snapshot-key',
      'snapshot ownerKey is always injected by mergeLocalOwnerKey when cachedProject has it',
    );
    // Content (name etc.) is from live
    assert.equal(selected.name, 'Live');
  });

  it('live draft with later edits is preferred over snapshot (content differs)', () => {
    const snap = makeProject({ id: 'proj-1', name: 'Snapshot', updatedAt: 1000 });
    const live = { ...makeProject({ id: 'proj-1', name: 'Snapshot', updatedAt: 2000 }) };
    const selected = selectDraftToSave(live, snap, 'proj-1');
    assert.equal(selected.updatedAt, 2000, 'newer updatedAt from live draft');
  });
});

// ─── 14. normalizeRecordProject – canonical identity + ownerKey merge ─────────
describe('normalizeRecordProject – canonical id/name overlay before ownerKey merge', () => {
  // Build a WebsiteRecord whose embedded projectSource can carry a DIFFERENT
  // id/name than the DB row (the duplicate-source bug the E2E surfaced).
  function makeRecord(overrides: {
    id?: string;
    name?: string;
    revision?: number;
    projectSourceId?: string;
    projectSourceName?: string;
    projectSourceOwnerKey?: string;
  } = {}) {
    const rec: ReceptionistConfig & { ownerKey?: string } = {
      enabled: true,
      assistantName: 'A',
      retellAgentId: PILOT_RETELL_AGENT_ID,
    };
    if (overrides.projectSourceOwnerKey) rec.ownerKey = overrides.projectSourceOwnerKey;
    return {
      id: overrides.id ?? 'canonical-id',
      name: overrides.name ?? 'Canonical Name',
      revision: overrides.revision ?? 1,
      status: 'active',
      schemaVersion: 1,
      projectSource: makeProject({
        id: overrides.projectSourceId ?? 'canonical-id',
        name: overrides.projectSourceName ?? 'Canonical Name',
        receptionist: rec,
      }),
      settings: {},
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('overlays canonical record.id when projectSource carries a stale source id', () => {
    const record = makeRecord({ id: 'new-db-id', projectSourceId: 'old-source-id' });
    const result = normalizeRecordProject(record, undefined);
    assert.equal(result.id, 'new-db-id', 'canonical DB id wins over stale source id');
  });

  it('overlays canonical record.name when projectSource carries a stale source name', () => {
    const record = makeRecord({ name: 'DB Name', projectSourceName: 'Stale Source Name' });
    const result = normalizeRecordProject(record, undefined);
    assert.equal(result.name, 'DB Name', 'canonical DB name wins over stale source name');
  });

  it('overlays BOTH id and name together for duplicate responses', () => {
    const record = makeRecord({
      id: 'dup-new-id',
      name: 'Copy of Site',
      projectSourceId: 'original-id',
      projectSourceName: 'Original Site',
    });
    const result = normalizeRecordProject(record, undefined);
    assert.equal(result.id, 'dup-new-id');
    assert.equal(result.name, 'Copy of Site');
  });

  it('leaves the source untouched (same reference) when id and name already match', () => {
    const record = makeRecord({ id: 'same', name: 'Same', projectSourceId: 'same', projectSourceName: 'Same' });
    const result = normalizeRecordProject(record, undefined);
    assert.equal(result.id, 'same');
    assert.equal(result.name, 'Same');
    assert.equal(result, record.projectSource, 'no reallocation when nothing differs and no cache merge');
  });

  it('ownerKey merge is keyed to the CANONICAL id, not the stale source id', () => {
    // Server row has canonical id 'new-db-id'; embedded source still says 'old-source-id'.
    const record = makeRecord({ id: 'new-db-id', projectSourceId: 'old-source-id' });
    // Cache holds the secret under the CANONICAL id.
    const cached = makeProject({
      id: 'new-db-id',
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'secret-for-canonical',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const result = normalizeRecordProject(record, cached);
    assert.equal(
      (result.receptionist as ReceptionistConfig & { ownerKey?: string })?.ownerKey,
      'secret-for-canonical',
      'ownerKey merges because id was normalized to canonical BEFORE the merge',
    );
  });

  it('ownerKey does NOT merge from a cache entry keyed to the stale source id', () => {
    const record = makeRecord({ id: 'new-db-id', projectSourceId: 'old-source-id' });
    // Cache keyed only to the stale source id must NOT leak into the canonical project.
    const staleCache = makeProject({
      id: 'old-source-id',
      receptionist: {
        enabled: true,
        assistantName: 'A',
        ownerKey: 'stale-secret',
        retellAgentId: PILOT_RETELL_AGENT_ID,
      } as ReceptionistConfig & { ownerKey: string },
    });
    const result = normalizeRecordProject(record, staleCache);
    assert.equal(
      (result.receptionist as ReceptionistConfig & { ownerKey?: string })?.ownerKey,
      undefined,
      'no ownerKey injected because cache id !== canonical id after normalization',
    );
  });

  it('preserves projectSource content while normalizing identity', () => {
    const record = makeRecord({ id: 'new-id', projectSourceId: 'old-id' });
    const result = normalizeRecordProject(record, undefined);
    assert.equal(result.templateId, 'home-services', 'non-identity content is preserved');
    assert.ok(result.pages.home, 'pages preserved');
  });
});
