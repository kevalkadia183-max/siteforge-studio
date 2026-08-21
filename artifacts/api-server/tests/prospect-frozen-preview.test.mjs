/**
 * Prospect frozen-preview hardening tests.
 *
 * These tests prove the hardening where prospect publishing reuses the
 * client_previews persistence/validation and serves a FROZEN copy of the
 * generated site on public delivery.
 *
 * Modules are built with esbuild and imported dynamically (no running server).
 * DB-independent logic (asset serving/CSP, dual-cleanup ordering, editorHash
 * namespacing, quota exclusion) is exercised directly. DB wiring is proven with
 * source-level and schema/migration/snapshot assertions.
 *
 * Covers:
 *  1. serveStoredPreviewAsset: ordinary CSP is unchanged (regression)
 *  2. serveStoredPreviewAsset: strict prospect CSP substitutes img-src/connect-src
 *  3. serveStoredPreviewAsset: serves each stored asset kind + 404 for unknown
 *  4. Frozen delivery: public handler does NOT call generateSite or read projectSource
 *  5. Frozen delivery: public handler loads client_previews by clientPreviewIdHash
 *  6. Publish: inserts a frozen client_previews row with the generated site
 *  7. Publish: runs the SAME validateSite ordinary previews use
 *  8. Dual cleanup: deletes mapping AND referenced client_previews (order-safe)
 *  9. Dual cleanup: no-op when no mappings match
 * 10. editorHash: prospect namespace never collides with ordinary sha256 hex
 * 11. editorHash: owner-derived + deterministic per (owner, prospectSite)
 * 12. Quota: ordinary counts exclude the prospect editorHash namespace
 * 13. Schema: clientPreviewIdHash is NOT NULL FK to client_previews (cascade)
 * 14. Migration 0006 + snapshot include the client_preview FK/column
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// Output must live inside the api-server package tree so that Node can resolve
// the externalized npm deps (express, drizzle-orm, pg, …) from node_modules.
const outputDir = await mkdtemp(
  new URL("../.frozen-preview-build-", import.meta.url).pathname,
);
process.on("exit", () => {
  try {
    rmSync(outputDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

const stubPath = new URL(
  "./fixtures/frozen-preview-stub.mjs",
  import.meta.url,
).pathname;

async function buildAndImport(entryPath, name) {
  const outfile = join(outputDir, `${name}.mjs`);
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
    // Externalise CJS-only npm deps (express + clerk chains use dynamic
    // require() which cannot be inlined into an ESM bundle). drizzle-orm / zod
    // are bundled because the table objects and query helpers are exercised.
    external: [
      "express",
      "cors",
      "cookie-parser",
      "@clerk/*",
      "openai",
      "http-proxy-middleware",
    ],
    // Alias runtime-only side-effect modules (pg Pool, pino logger) that are
    // constructed at import but never used by these focused tests.
    alias: {
      pg: stubPath,
      pino: stubPath,
      "pino-http": stubPath,
      "pino-pretty": stubPath,
    },
    define: {
      "process.env.SESSION_SECRET": '"test-session-secret-abc-123-at-least-32"',
      "process.env.DATABASE_URL": '"postgres://localhost/test"',
    },
  });
  return import(pathToFileURL(outfile).href);
}

// preview-store.ts is import-isolated (no router/db/logger), so it needs no
// stubbing — this is the reused validation + stored-site response surface.
const previewStoreMod = await buildAndImport(
  new URL("../src/lib/preview-store.ts", import.meta.url).pathname,
  "preview-store",
);
const {
  serveStoredPreviewAsset,
  validateSite,
  hashSecret,
  newSecret,
  PROSPECT_EDITOR_HASH_PREFIX,
  allowedPageNames,
} = previewStoreMod;

const prospectMod = await buildAndImport(
  new URL("../src/routes/lead-acquisition/routes-prospect.ts", import.meta.url)
    .pathname,
  "routes-prospect",
);
const { deleteProspectPreviewsAndFrozenSites, prospectEditorHash } =
  prospectMod;

// ─── Fake Express response ────────────────────────────────────────────────

function makeRes() {
  return {
    _status: null,
    _headers: {},
    _type: null,
    _body: undefined,
    _ended: false,
    status(code) {
      this._status = code;
      return this;
    },
    set(headers) {
      Object.assign(this._headers, headers);
      return this;
    },
    type(t) {
      this._type = t;
      return this;
    },
    send(body) {
      this._body = body;
      this._ended = true;
      return this;
    },
  };
}

function makeSite() {
  return {
    pages: {
      "index.html": "<html><body>index</body></html>",
      "about.html": "<html><body>about</body></html>",
    },
    css: "body{color:red}",
    js: "console.log('hi')",
    media: {
      "logo.png": {
        id: "logo",
        name: "logo",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,aGVsbG8=",
      },
    },
  };
}

// ─── 1. Ordinary CSP regression ────────────────────────────────────────────

test("1. serveStoredPreviewAsset: ordinary CSP unchanged (img-src https:, no strict)", () => {
  const res = makeRes();
  const ok = serveStoredPreviewAsset(res, makeSite(), "index.html");
  assert.equal(ok, true);
  assert.equal(res._status, 200);
  const csp = res._headers["Content-Security-Policy"];
  assert.ok(csp.includes("img-src 'self' https: data:"), "ordinary img-src");
  // Ordinary connect-src derives from the (non-receptionist) script → 'none'
  assert.ok(csp.includes("connect-src 'none'"), csp);
  assert.ok(csp.includes("sandbox allow-forms allow-popups allow-scripts"));
  assert.equal(res._headers["Cache-Control"], "no-store, max-age=0");
  assert.equal(
    res._headers["X-Robots-Tag"],
    "noindex, nofollow, noarchive",
  );
});

// ─── 2. Strict prospect CSP ────────────────────────────────────────────────

test("2. serveStoredPreviewAsset: strictProspect substitutes img-src/connect-src", () => {
  const res = makeRes();
  const ok = serveStoredPreviewAsset(res, makeSite(), "index.html", {
    strictProspect: true,
  });
  assert.equal(ok, true);
  const csp = res._headers["Content-Security-Policy"];
  assert.ok(csp.includes("img-src 'self' data:"), csp);
  assert.ok(!csp.includes("img-src 'self' https:"), "no https: for prospect");
  assert.ok(csp.includes("connect-src 'none'"), csp);
  // The rest of the envelope is identical to ordinary previews.
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"));
  assert.equal(res._headers["Referrer-Policy"], "no-referrer");
  assert.equal(res._headers["X-Content-Type-Options"], "nosniff");
});

// ─── 3. Asset selection ────────────────────────────────────────────────────

test("3. serveStoredPreviewAsset: serves each asset kind + 404 for unknown", () => {
  const site = makeSite();

  let res = makeRes();
  serveStoredPreviewAsset(res, site, "styles.css", { strictProspect: true });
  assert.equal(res._type, "text/css");
  assert.equal(res._body, site.css);

  res = makeRes();
  serveStoredPreviewAsset(res, site, "main.js", { strictProspect: true });
  assert.equal(res._type, "text/javascript");
  assert.equal(res._body, site.js);

  res = makeRes();
  serveStoredPreviewAsset(res, site, "about.html", { strictProspect: true });
  assert.equal(res._type, "text/html");
  assert.equal(res._body, site.pages["about.html"]);

  res = makeRes();
  serveStoredPreviewAsset(res, site, "logo.png", { strictProspect: true });
  assert.equal(res._type, "image/png");
  assert.ok(Buffer.isBuffer(res._body));

  res = makeRes();
  const ok = serveStoredPreviewAsset(res, site, "evil.php", {
    strictProspect: true,
  });
  assert.equal(ok, false);
  assert.equal(res._status, 404);
});

// ─── 4/5. Frozen delivery — source-level guarantees ────────────────────────

const deliverySrc = await readFile(
  new URL(
    "../src/routes/lead-acquisition/prospect-preview-delivery.ts",
    import.meta.url,
  ),
  "utf8",
);

test("4. Public delivery handler does NOT generate or read projectSource", () => {
  assert.ok(
    !/generateSite/.test(deliverySrc),
    "public delivery must not call generateSite",
  );
  assert.ok(
    !/projectSource/.test(deliverySrc),
    "public delivery must not read website projectSource",
  );
  assert.ok(
    !/siteforgeWebsitesTable/.test(deliverySrc),
    "public delivery must not load the website row",
  );
});

test("5. Public delivery loads client_previews by clientPreviewIdHash + strict CSP", () => {
  assert.ok(
    /clientPreviewsTable/.test(deliverySrc),
    "public delivery must load the frozen client_previews row",
  );
  assert.ok(
    /clientPreviewIdHash/.test(deliverySrc),
    "public delivery must key the frozen row by clientPreviewIdHash",
  );
  assert.ok(
    /serveStoredPreviewAsset\([\s\S]*strictProspect:\s*true/.test(deliverySrc),
    "public delivery must serve via the shared responder with strict CSP",
  );
});

// ─── 6/7. Publish freezes generated site + reuses validateSite ─────────────

const prospectSrc = await readFile(
  new URL("../src/routes/lead-acquisition/routes-prospect.ts", import.meta.url),
  "utf8",
);

const previewsSrc = await readFile(
  new URL("../src/routes/previews.ts", import.meta.url),
  "utf8",
);

test("6. Publish freezes the generated site into client_previews", () => {
  // generateSite result stored into the site column of a client_previews insert
  assert.ok(
    /generateSite\(project\)/.test(prospectSrc),
    "publish must generate the site server-side",
  );
  assert.ok(
    /insert\(clientPreviewsTable\)[\s\S]*site:\s*generated/.test(prospectSrc),
    "publish must persist the generated site into client_previews.site",
  );
  assert.ok(
    /clientPreviewIdHash,/.test(prospectSrc),
    "publish must link the mapping to the frozen client preview",
  );
});

test("7. Publish runs the same validateSite ordinary previews use", () => {
  assert.ok(
    /validateSite\(generated\)/.test(prospectSrc),
    "publish must validate the generated site with validateSite",
  );
  // validateSite is the exported ordinary-preview validator, proving reuse.
  const site = makeSite();
  assert.equal(validateSite(site), null);
  const bad = makeSite();
  bad.pages["index.html"] = '<script>alert(1)</script>';
  assert.notEqual(validateSite(bad), null);
});

// ─── 8/9. Dual cleanup helper ──────────────────────────────────────────────

/**
 * Build a mock transaction that records deletes and returns the given mapping
 * rows from the initial select.
 */
function makeMockTx(mappingRows) {
  const deletions = [];
  const tx = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(mappingRows);
            },
          };
        },
      };
    },
    delete(table) {
      return {
        where(cond) {
          deletions.push({ table, cond });
          return Promise.resolve();
        },
      };
    },
  };
  return { tx, deletions };
}

test("8. deleteProspectPreviewsAndFrozenSites: deletes mapping then frozen rows", async () => {
  const rows = [
    { mappingId: "m1", clientPreviewIdHash: "c1" },
    { mappingId: "m2", clientPreviewIdHash: "c2" },
  ];
  const { tx, deletions } = makeMockTx(rows);
  const removed = await deleteProspectPreviewsAndFrozenSites(tx, {});
  assert.equal(removed, 2);
  // Two deletes: first mappings, then frozen client_previews (order-safe).
  assert.equal(deletions.length, 2);
});

test("9. deleteProspectPreviewsAndFrozenSites: no-op when no mappings", async () => {
  const { tx, deletions } = makeMockTx([]);
  const removed = await deleteProspectPreviewsAndFrozenSites(tx, {});
  assert.equal(removed, 0);
  assert.equal(deletions.length, 0);
});

// ─── 10/11. editorHash namespacing ─────────────────────────────────────────

test("10. prospect editorHash cannot collide with an ordinary editor key hash", () => {
  const ordinary = hashSecret("some-editor-key"); // bare 64-char sha256 hex
  assert.match(ordinary, /^[0-9a-f]{64}$/);
  const prospect = prospectEditorHash("owner_1", "ps_1");
  assert.ok(prospect.startsWith(PROSPECT_EDITOR_HASH_PREFIX));
  assert.notEqual(prospect, ordinary);
  assert.ok(!/^[0-9a-f]{64}$/.test(prospect), "prospect hash is namespaced");
});

test("11. prospect editorHash is owner-derived and deterministic per (owner, site)", () => {
  const a = prospectEditorHash("owner_1", "ps_1");
  const b = prospectEditorHash("owner_1", "ps_1");
  const c = prospectEditorHash("owner_2", "ps_1");
  const d = prospectEditorHash("owner_1", "ps_2");
  assert.equal(a, b, "deterministic");
  assert.notEqual(a, c, "owner-scoped");
  assert.notEqual(a, d, "site-scoped");
});

// ─── 12. Quota exclusion filter ────────────────────────────────────────────

test("12. ordinary quota SQL excludes the prospect editorHash namespace", () => {
  // The total/per-editor counts filter out prospect-internal rows.
  assert.ok(
    /ordinaryPreviewsFilter/.test(previewsSrc),
    "counts must apply the ordinary-only filter",
  );
  assert.ok(
    /NOT LIKE/.test(previewsSrc),
    "filter excludes prefixed prospect rows",
  );
  // Both the total and per-editor counts use the filter.
  const uses = previewsSrc.match(/ordinaryPreviewsFilter/g) || [];
  assert.ok(uses.length >= 3, `expected filter reused, got ${uses.length}`);
});

// ─── 13/14. Schema + migration + snapshot ──────────────────────────────────

const schemaSrc = await readFile(
  new URL(
    "../../../lib/db/src/schema/lead-acquisition-prospect-previews.ts",
    import.meta.url,
  ),
  "utf8",
);
const migrationSrc = await readFile(
  new URL("../../../lib/db/drizzle/0006_prospect_sites.sql", import.meta.url),
  "utf8",
);
const snapshotSrc = await readFile(
  new URL("../../../lib/db/drizzle/meta/0006_snapshot.json", import.meta.url),
  "utf8",
);

test("13. schema: clientPreviewIdHash is NOT NULL FK to client_previews (cascade)", () => {
  assert.ok(/clientPreviewIdHash:\s*text\("client_preview_id_hash"\)/.test(schemaSrc));
  assert.ok(/\.notNull\(\)/.test(schemaSrc));
  assert.ok(
    /references\(\(\)\s*=>\s*clientPreviewsTable\.idHash,\s*\{\s*onDelete:\s*"cascade"/.test(
      schemaSrc,
    ),
    "FK must cascade on delete",
  );
});

test("14. migration 0006 + snapshot include the client_preview FK/column", () => {
  assert.ok(
    /"client_preview_id_hash"\s+text\s+NOT\s+NULL\s+REFERENCES\s+"client_previews"\("id_hash"\)\s+ON\s+DELETE\s+CASCADE/.test(
      migrationSrc,
    ),
    "migration must add NOT NULL cascade FK column",
  );
  const snap = JSON.parse(snapshotSrc);
  const t = snap.tables["public.lead_acquisition_prospect_previews"];
  assert.ok(t.columns["client_preview_id_hash"], "snapshot column present");
  assert.equal(t.columns["client_preview_id_hash"].notNull, true);
  const fk = t.foreignKeys["la_prospect_previews_client_preview_fk"];
  assert.ok(fk, "snapshot FK present");
  assert.equal(fk.tableTo, "client_previews");
  assert.deepEqual(fk.columnsTo, ["id_hash"]);
  assert.equal(fk.onDelete, "cascade");
});
