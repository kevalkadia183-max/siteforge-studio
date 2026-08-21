import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const outputDirectory = await mkdtemp(
  join(tmpdir(), "siteforge-receptionist-provisioning-"),
);
const outputFile = join(outputDirectory, "receptionist-provisioning.mjs");

const dbMock = `
  const state = {
    users: [],
    receptionists: [],
    auditEvents: [],
  };

  const table = (name) => Object.freeze({ name });
  export const siteforgeUsersTable = table("siteforgeUsers");
  export const receptionistsTable = table("receptionists");
  export const receptionistConversationsTable = table("receptionistConversations");
  export const receptionistMessagesTable = table("receptionistMessages");
  export const receptionistAuditEventsTable = table("receptionistAuditEvents");

  function upsertUser(values) {
    const existing = state.users.find((user) => user.id === values.id);
    if (existing) Object.assign(existing, values);
    else state.users.push({ ...values });
  }

  export const db = {
    insert(target) {
      return {
        values(values) {
          if (target === siteforgeUsersTable) upsertUser(values);
          if (target === receptionistsTable) state.receptionists.push({ ...values });
          if (target === receptionistAuditEventsTable) state.auditEvents.push({ ...values });
          return {
            onConflictDoUpdate() {
              return Promise.resolve();
            },
            onConflictDoNothing() {
              return Promise.resolve();
            },
          };
        },
      };
    },
    select() {
      throw new Error("This provisioning test must not read receptionist ownership.");
    },
  };

  export function getTestState() {
    return structuredClone(state);
  }
`;

const clerkMock = `
  export function getAuth(req) {
    const userId = req.get("X-Test-Clerk-User-Id");
    return userId
      ? { userId, sessionClaims: { email: "owner@example.test" } }
      : { userId: null, sessionClaims: null };
  }
`;

await build({
  stdin: {
    contents: `
      import express from "express";
      import receptionistRouter from "./src/routes/receptionist/receptionist.ts";
      export { getTestState } from "@workspace/db";

      export const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.log = { info() {}, error() {}, warn() {}, debug() {} };
        next();
      });
      app.use("/api", receptionistRouter);
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "receptionist-provisioning-api-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outputFile,
  logLevel: "silent",
  banner: {
    js: `
      import { createRequire as __createRequire } from "node:module";
      import __bannerPath from "node:path";
      import __bannerUrl from "node:url";
      globalThis.require = __createRequire(import.meta.url);
      globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
      globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
  },
  plugins: [
    {
      name: "receptionist-provisioning-test-dependencies",
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^@workspace\/db$/ }, () => ({
          path: "db",
          namespace: "provisioning-test",
        }));
        pluginBuild.onResolve({ filter: /^@clerk\/express$/ }, () => ({
          path: "clerk",
          namespace: "provisioning-test",
        }));
        pluginBuild.onLoad(
          { filter: /^db$/, namespace: "provisioning-test" },
          () => ({ contents: dbMock, loader: "js" }),
        );
        pluginBuild.onLoad(
          { filter: /^clerk$/, namespace: "provisioning-test" },
          () => ({ contents: clerkMock, loader: "js" }),
        );
      },
    },
  ],
});

process.env.SITEFORGE_PILOT_SETUP_KEY = "configured-for-test";
const { app, getTestState } = await import(pathToFileURL(outputFile).href);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error(
    "Receptionist provisioning test server did not bind to a TCP port.",
  );
}
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  server.close();
  await once(server, "close");
  delete process.env.SITEFORGE_PILOT_SETUP_KEY;
  await rm(outputDirectory, { recursive: true, force: true });
});

test("a signed-in Clerk owner can create an owner-scoped receptionist without a setup key", async () => {
  const response = await fetch(`${baseUrl}/api/receptionist`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Clerk-User-Id": "user_clerk_owner",
    },
    body: JSON.stringify({
      businessName: "Endpoint Coverage LLC",
      assistantName: "Morgan",
    }),
  });

  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(typeof created.receptionistId, "string");

  const state = getTestState();
  assert.equal(
    state.users.length,
    1,
    "the verified Clerk owner is JIT-upserted",
  );
  assert.equal(state.users[0].id, "user_clerk_owner");
  assert.equal(state.receptionists.length, 1);
  assert.equal(state.receptionists[0].id, created.receptionistId);
  assert.equal(state.receptionists[0].ownerId, "user_clerk_owner");
  assert.equal(state.receptionists[0].pilotSlot, null);
});

test("an anonymous request without the legacy setup key remains rejected", async () => {
  const before = getTestState().receptionists.length;
  const response = await fetch(`${baseUrl}/api/receptionist`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessName: "Anonymous Attempt" }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "Sign in to SiteForge or provide a valid pilot setup key.",
  });
  assert.equal(
    getTestState().receptionists.length,
    before,
    "rejected anonymous requests must not create receptionists",
  );
});
