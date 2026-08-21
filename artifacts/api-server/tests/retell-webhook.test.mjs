import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const outputDirectory = await mkdtemp(join(tmpdir(), "siteforge-retell-webhook-"));
const webhookOutput = join(outputDirectory, "retell-webhook.mjs");
const ingestionOutput = join(outputDirectory, "retell-call-ingestion.mjs");
const apiOutput = join(outputDirectory, "stdin.mjs");
await Promise.all([
  build({
    entryPoints: [
      new URL("../src/lib/retell-webhook.ts", import.meta.url).pathname,
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: webhookOutput,
    logLevel: "silent",
  }),
  build({
    entryPoints: [
      new URL("../src/lib/retell-call-ingestion.ts", import.meta.url).pathname,
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: ingestionOutput,
    logLevel: "silent",
  }),
  build({
    stdin: {
      contents: `
        import { eq, inArray } from "drizzle-orm";
        import app from "./src/app.ts";
        import {
          db,
          pool,
          receptionistAuditEventsTable,
        } from "@workspace/db";

        export { app };

        export async function listRejectedWebhookAudits() {
          return db
            .select({
              id: receptionistAuditEventsTable.id,
              metadata: receptionistAuditEventsTable.metadata,
            })
            .from(receptionistAuditEventsTable)
            .where(
              eq(
                receptionistAuditEventsTable.eventType,
                "retell_webhook_rejected",
              ),
            );
        }

        export async function deleteAuditEvents(ids) {
          if (ids.length === 0) return;
          await db
            .delete(receptionistAuditEventsTable)
            .where(inArray(receptionistAuditEventsTable.id, ids));
        }

        export async function closeTestDatabasePool() {
          await pool.end();
        }
      `,
      resolveDir: new URL("..", import.meta.url).pathname,
      sourcefile: "retell-webhook-api-test-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outdir: outputDirectory,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
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
  }),
]);

const {
  hashRetellWebhookPayload,
  parseRetellWebhookPayload,
  verifyRetellWebhookSignature,
} = await import(pathToFileURL(webhookOutput).href);
const { ingestEndedRetellCall } = await import(
  pathToFileURL(ingestionOutput).href
);

const apiKey = "webhook-api-key";
const nowMs = Date.parse("2026-08-20T12:00:00.000Z");
process.env.RETELL_WEBHOOK_API_KEY = apiKey;
const {
  app,
  closeTestDatabasePool,
  deleteAuditEvents,
  listRejectedWebhookAudits,
} = await import(pathToFileURL(apiOutput).href);

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Retell webhook test server did not bind to a TCP port.");
}
const baseUrl = `http://127.0.0.1:${address.port}`;
const createdAuditEventIds = new Set();

test.after(async () => {
  await deleteAuditEvents([...createdAuditEventIds]);
  server.close();
  await once(server, "close");
  await closeTestDatabasePool();
});

const rawBody = JSON.stringify({
  event: "call_ended",
  call: {
    call_id: "call-1",
    agent_id: "agent-1",
    call_status: "ended",
    start_timestamp: nowMs - 60_000,
    transcript_object: [
      { role: "user", content: "Hello" },
      { role: "agent", content: "How can I help?" },
    ],
  },
});

function sign(body, timestamp = nowMs) {
  const digest = createHmac("sha256", apiKey)
    .update(`${body}${timestamp}`, "utf8")
    .digest("hex");
  return `v=${timestamp},d=${digest}`;
}

function findNewAudit(before, after, reason) {
  const priorIds = new Set(before.map((audit) => audit.id));
  const audit = after.find(
    (candidate) =>
      !priorIds.has(candidate.id) && candidate.metadata?.reason === reason,
  );
  assert.ok(audit, `Expected a new ${reason} Retell rejection audit.`);
  createdAuditEventIds.add(audit.id);
  return audit;
}

test("accepts Retell's timestamped HMAC over the exact raw body", () => {
  assert.deepEqual(
    verifyRetellWebhookSignature(rawBody, apiKey, sign(rawBody), nowMs),
    { valid: true, timestamp: nowMs },
  );
  assert.equal(hashRetellWebhookPayload(rawBody).length, 64);
});

test("accepts a signed Retell delivery through the raw HTTP webhook path", async () => {
  const body = JSON.stringify({
    event: "call_started",
    call: { call_id: "http-valid-call" },
  });
  const timestamp = Date.now();
  const response = await fetch(`${baseUrl}/api/receptionist/retell/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Retell-Signature": sign(body, timestamp),
    },
    body,
  });

  assert.equal(response.status, 204);
});

test("rejects a tampered HTTP delivery and records metadata-only audit evidence", async () => {
  const originalBody = JSON.stringify({
    event: "call_started",
    call: { call_id: "http-tampered-call" },
    marker: "must-not-appear-in-audit",
  });
  const tamperedBody = `${originalBody} `;
  const timestamp = Date.now();
  const before = await listRejectedWebhookAudits();
  const response = await fetch(`${baseUrl}/api/receptionist/retell/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Retell-Signature": sign(originalBody, timestamp),
    },
    body: tamperedBody,
  });

  const audit = findNewAudit(
    before,
    await listRejectedWebhookAudits(),
    "invalid_signature",
  );
  assert.equal(response.status, 401);
  assert.deepEqual(audit.metadata, {
    reason: "invalid_signature",
    payloadHash: hashRetellWebhookPayload(tamperedBody),
    signatureTimestamp: timestamp,
  });
  assert.doesNotMatch(
    JSON.stringify(audit.metadata),
    /must-not-appear-in-audit/,
  );
});

test("rejects an oversized HTTP delivery and records no payload data", async () => {
  const oversizedBody = JSON.stringify({
    event: "call_started",
    marker: "must-not-appear-in-audit",
    padding: "x".repeat(4 * 1024 * 1024),
  });
  const before = await listRejectedWebhookAudits();
  const response = await fetch(`${baseUrl}/api/receptionist/retell/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Retell-Signature": sign(oversizedBody, Date.now()),
    },
    body: oversizedBody,
  });

  const audit = findNewAudit(
    before,
    await listRejectedWebhookAudits(),
    "payload_too_large",
  );
  assert.equal(response.status, 413);
  assert.deepEqual(audit.metadata, {
    reason: "payload_too_large",
    payloadHash: null,
  });
  assert.doesNotMatch(
    JSON.stringify(audit.metadata),
    /must-not-appear-in-audit/,
  );
});

test("rejects tampered and stale webhook signatures", () => {
  const tampered = `${rawBody} `;
  assert.deepEqual(
    verifyRetellWebhookSignature(tampered, apiKey, sign(rawBody), nowMs),
    {
      valid: false,
      reason: "invalid_signature",
      timestamp: nowMs,
    },
  );

  const staleTimestamp = nowMs - 5 * 60_000 - 1;
  assert.deepEqual(
    verifyRetellWebhookSignature(
      rawBody,
      apiKey,
      sign(rawBody, staleTimestamp),
      nowMs,
    ),
    {
      valid: false,
      reason: "stale_signature",
      timestamp: staleTimestamp,
    },
  );
});

test("validates call-ended payloads and ignores unrelated Retell events", () => {
  const parsed = parseRetellWebhookPayload(rawBody);
  assert.equal(parsed.kind, "call_ended");
  assert.equal(parsed.call.call_id, "call-1");

  assert.deepEqual(
    parseRetellWebhookPayload(
      JSON.stringify({ event: "call_started", call: {} }),
    ),
    { kind: "ignored", event: "call_started" },
  );
  assert.deepEqual(parseRetellWebhookPayload("{"), {
    kind: "invalid",
    reason: "invalid_json",
  });
});

function createHarness() {
  let id = 0;
  const state = {
    deliveries: new Set(),
    conversations: new Map(),
    messages: new Map(),
    auditEvents: [],
  };
  let failNextMessage = false;

  function cloneState() {
    return {
      deliveries: new Set(state.deliveries),
      conversations: new Map(state.conversations),
      messages: new Map(state.messages),
      auditEvents: structuredClone(state.auditEvents),
    };
  }

  const dependencies = {
    newId: () => `id-${++id}`,
    now: () => new Date(nowMs),
    async transaction(work) {
      const pending = cloneState();
      const outcome = await work({
        async claimWebhookDelivery(claim) {
          if (pending.deliveries.has(claim.deliveryKey)) return false;
          pending.deliveries.add(claim.deliveryKey);
          return true;
        },
        async createConversation(conversation) {
          const key = `${conversation.receptionistId}:${conversation.externalId}`;
          if (pending.conversations.has(key)) return false;
          pending.conversations.set(key, conversation);
          return true;
        },
        async findConversationId(receptionistId, callId) {
          return (
            pending.conversations.get(`${receptionistId}:${callId}`)?.id ?? null
          );
        },
        async createMessage(message) {
          if (failNextMessage) {
            failNextMessage = false;
            throw new Error("simulated insert failure");
          }
          const key = `${message.receptionistId}:${message.externalMessageId}`;
          if (pending.messages.has(key)) return false;
          pending.messages.set(key, message);
          return true;
        },
        async createAuditEvent(event) {
          pending.auditEvents.push(event);
        },
      });
      state.deliveries = pending.deliveries;
      state.conversations = pending.conversations;
      state.messages = pending.messages;
      state.auditEvents = pending.auditEvents;
      return outcome;
    },
  };

  return {
    state,
    dependencies,
    failNextMessage: () => {
      failNextMessage = true;
    },
  };
}

function webhookInput() {
  return {
    receptionistId: "receptionist-1",
    call: parseRetellWebhookPayload(rawBody).call,
    source: "webhook",
    webhook: {
      deliveryKey: "call_ended:call-1",
      payloadHash: hashRetellWebhookPayload(rawBody),
      signatureTimestamp: nowMs,
    },
  };
}

test("atomically imports an ended call and audits a repeated delivery", async () => {
  const harness = createHarness();

  const first = await ingestEndedRetellCall(
    webhookInput(),
    harness.dependencies,
  );
  assert.deepEqual(first, {
    kind: "imported",
    conversationCreated: true,
    messagesCreated: 2,
  });
  assert.equal(harness.state.deliveries.size, 1);
  assert.equal(harness.state.conversations.size, 1);
  assert.equal(harness.state.messages.size, 2);

  const replay = await ingestEndedRetellCall(
    webhookInput(),
    harness.dependencies,
  );
  assert.deepEqual(replay, {
    kind: "replay",
    conversationCreated: false,
    messagesCreated: 0,
  });
  assert.equal(harness.state.conversations.size, 1);
  assert.equal(harness.state.messages.size, 2);
  assert.deepEqual(
    harness.state.auditEvents.map((event) => event.eventType),
    ["retell_call_webhook_ingested", "retell_webhook_replay_rejected"],
  );
});

test("rolls back the delivery claim when call import fails", async () => {
  const harness = createHarness();
  harness.failNextMessage();

  await assert.rejects(
    ingestEndedRetellCall(webhookInput(), harness.dependencies),
    /simulated insert failure/,
  );
  assert.equal(harness.state.deliveries.size, 0);
  assert.equal(harness.state.conversations.size, 0);
  assert.equal(harness.state.messages.size, 0);

  const retry = await ingestEndedRetellCall(
    webhookInput(),
    harness.dependencies,
  );
  assert.equal(retry.kind, "imported");
  assert.equal(harness.state.deliveries.size, 1);
  assert.equal(harness.state.conversations.size, 1);
});

test("manual recovery sync remains idempotent after webhook ingestion", async () => {
  const harness = createHarness();
  await ingestEndedRetellCall(webhookInput(), harness.dependencies);

  const manual = await ingestEndedRetellCall(
    {
      receptionistId: "receptionist-1",
      call: parseRetellWebhookPayload(rawBody).call,
      source: "manual_sync",
    },
    harness.dependencies,
  );
  assert.deepEqual(manual, {
    kind: "already_imported",
    conversationCreated: false,
    messagesCreated: 0,
  });
  assert.equal(harness.state.conversations.size, 1);
  assert.equal(harness.state.messages.size, 2);
});