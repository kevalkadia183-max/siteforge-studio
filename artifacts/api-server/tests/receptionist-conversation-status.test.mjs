import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const outputDirectory = await mkdtemp(
  join(tmpdir(), "siteforge-conversation-status-"),
);
const outputFile = join(outputDirectory, "receptionist-conversation-status.mjs");
await build({
  stdin: {
    contents: `
      import express from "express";
      import { clerkMiddleware } from "@clerk/express";
      import { and, asc, eq } from "drizzle-orm";
      import {
        db,
        pool,
        receptionistsTable,
        receptionistAuditEventsTable,
        receptionistConversationsTable,
        receptionistMessagesTable,
      } from "@workspace/db";
      import receptionistRouter from "./src/routes/receptionist/receptionist.ts";
      import {
        recordGmailInboundConversationActivity,
        updateConversationStatus,
      } from "./src/lib/receptionist-conversation-transitions.ts";
      import { hashSecret } from "./src/lib/receptionist-auth.ts";
      import {
        conversationVersionMatches,
        statusAfterInboundActivity,
      } from "./src/lib/receptionist-conversation-status.ts";

      export {
        conversationVersionMatches,
        recordGmailInboundConversationActivity,
        statusAfterInboundActivity,
        updateConversationStatus,
      };

      export function createTestApp() {
        const app = express();
        app.use(express.json());
        app.use(clerkMiddleware());
        app.use("/api", receptionistRouter);
        return app;
      }

      export async function seedReceptionist({ id, ownerKey }) {
        await db.insert(receptionistsTable).values({
          id,
          ownerKeyHash: hashSecret(ownerKey),
          businessName: "Status regression test",
        });
      }

      export async function seedConversation({
        id,
        receptionistId,
        channel = "chat",
        externalId = null,
        subject = null,
        status,
        updatedAt,
      }) {
        await db.insert(receptionistConversationsTable).values({
          id,
          receptionistId,
          channel,
          externalId,
          subject,
          status,
          createdAt: updatedAt,
          updatedAt,
        });
      }

      export async function seedAuditEvent({
        id,
        receptionistId,
        conversationId,
      }) {
        await db.insert(receptionistAuditEventsTable).values({
          id,
          receptionistId,
          conversationId,
          eventType: "test_collision",
        });
      }

      export async function getConversation(id) {
        const [conversation] = await db
          .select()
          .from(receptionistConversationsTable)
          .where(eq(receptionistConversationsTable.id, id))
          .limit(1);
        return conversation ?? null;
      }

      export async function getAuditEvents(receptionistId, conversationId) {
        return db
          .select()
          .from(receptionistAuditEventsTable)
          .where(
            and(
              eq(receptionistAuditEventsTable.receptionistId, receptionistId),
              eq(receptionistAuditEventsTable.conversationId, conversationId),
            ),
          )
          .orderBy(asc(receptionistAuditEventsTable.createdAt));
      }

      export async function cleanupReceptionist(receptionistId) {
        await db
          .delete(receptionistMessagesTable)
          .where(eq(receptionistMessagesTable.receptionistId, receptionistId));
        await db
          .delete(receptionistAuditEventsTable)
          .where(eq(receptionistAuditEventsTable.receptionistId, receptionistId));
        await db
          .delete(receptionistConversationsTable)
          .where(eq(receptionistConversationsTable.receptionistId, receptionistId));
        await db
          .delete(receptionistsTable)
          .where(eq(receptionistsTable.id, receptionistId));
      }

      export async function closeTestDatabasePool() {
        await pool.end();
      }
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "receptionist-conversation-status-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outputFile,
  logLevel: "silent",
  banner: {
    js: `
      import { createRequire as __createRequire } from "node:module";
      globalThis.require = __createRequire(import.meta.url);
    `,
  },
});

const {
  cleanupReceptionist,
  closeTestDatabasePool,
  conversationVersionMatches,
  createTestApp,
  getAuditEvents,
  getConversation,
  recordGmailInboundConversationActivity,
  seedAuditEvent,
  seedConversation,
  seedReceptionist,
  statusAfterInboundActivity,
  updateConversationStatus,
} = await import(pathToFileURL(outputFile).href);

const ownerKey = "status-test-owner-key-12345";
const server = createTestApp().listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Conversation status test server did not bind to a TCP port.");
}
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  server.close();
  await once(server, "close");
  await closeTestDatabasePool();
});

function uniqueId(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function withReceptionist(run) {
  const receptionistId = uniqueId("status-receptionist");
  await seedReceptionist({ id: receptionistId, ownerKey });
  try {
    await run(receptionistId);
  } finally {
    await cleanupReceptionist(receptionistId);
  }
}

test("inbound activity reopens resolved conversations", () => {
  assert.equal(statusAfterInboundActivity("closed"), "open");
});

test("inbound activity never clears an escalation", () => {
  assert.equal(statusAfterInboundActivity("escalated"), "escalated");
});

test("inbound activity leaves an open conversation open", () => {
  assert.equal(statusAfterInboundActivity("open"), "open");
});

test("stale conversation versions are rejected", () => {
  const viewedAt = new Date("2026-08-20T12:00:00.000Z");
  const changedAt = new Date("2026-08-20T12:00:00.001Z");

  assert.equal(conversationVersionMatches(viewedAt, viewedAt), true);
  assert.equal(conversationVersionMatches(changedAt, viewedAt), false);
});

test("a stale Resolve request returns 409 and preserves the newer escalation", async () => {
  await withReceptionist(async (receptionistId) => {
    const conversationId = uniqueId("stale-resolve");
    const viewedAt = new Date("2026-08-20T12:00:00.000Z");
    await seedConversation({
      id: conversationId,
      receptionistId,
      status: "open",
      updatedAt: viewedAt,
    });

    const escalation = await updateConversationStatus({
      receptionistId,
      conversationId,
      status: "escalated",
      expectedUpdatedAt: viewedAt,
      changedAt: new Date("2026-08-20T12:00:01.000Z"),
    });
    assert.equal(escalation.kind, "updated");

    const staleResolve = await fetch(
      `${baseUrl}/api/receptionist/${receptionistId}/conversations/${conversationId}/status`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-SiteForge-Owner-Key": ownerKey,
        },
        body: JSON.stringify({
          status: "closed",
          expectedUpdatedAt: viewedAt.toISOString(),
        }),
      },
    );
    assert.equal(staleResolve.status, 409);
    assert.deepEqual(await staleResolve.json(), {
      error: "Conversation status changed. Refresh and try again.",
    });

    const conversation = await getConversation(conversationId);
    assert.equal(conversation.status, "escalated");
    const auditEvents = await getAuditEvents(receptionistId, conversationId);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].eventType, "conversation_status_changed");
    assert.deepEqual(auditEvents[0].metadata, {
      previousStatus: "open",
      status: "escalated",
    });
  });
});

test("a failed audit insert rolls back the status transition atomically", async () => {
  await withReceptionist(async (receptionistId) => {
    const conversationId = uniqueId("atomic-status");
    const collisionId = uniqueId("audit-collision");
    const viewedAt = new Date("2026-08-20T13:00:00.000Z");
    await seedConversation({
      id: conversationId,
      receptionistId,
      status: "open",
      updatedAt: viewedAt,
    });
    await seedAuditEvent({
      id: collisionId,
      receptionistId,
      conversationId,
    });

    await assert.rejects(
      updateConversationStatus({
        receptionistId,
        conversationId,
        status: "closed",
        expectedUpdatedAt: viewedAt,
        changedAt: new Date("2026-08-20T13:00:01.000Z"),
        newAuditEventId: () => collisionId,
      }),
      (error) => error?.cause?.code === "23505",
    );

    const conversation = await getConversation(conversationId);
    assert.equal(conversation.status, "open");
    assert.equal(conversation.updatedAt.getTime(), viewedAt.getTime());
    const auditEvents = await getAuditEvents(receptionistId, conversationId);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].eventType, "test_collision");
  });
});

test("Gmail inbound activity reopens closed threads but preserves escalations", async () => {
  await withReceptionist(async (receptionistId) => {
    const closedConversationId = uniqueId("gmail-closed");
    const escalatedConversationId = uniqueId("gmail-escalated");
    const viewedAt = new Date("2026-08-20T14:00:00.000Z");
    await seedConversation({
      id: closedConversationId,
      receptionistId,
      channel: "email",
      externalId: uniqueId("gmail-thread"),
      subject: "Old closed subject",
      status: "closed",
      updatedAt: viewedAt,
    });
    await seedConversation({
      id: escalatedConversationId,
      receptionistId,
      channel: "email",
      externalId: uniqueId("gmail-thread"),
      subject: "Old escalated subject",
      status: "escalated",
      updatedAt: viewedAt,
    });

    await recordGmailInboundConversationActivity({
      receptionistId,
      conversationId: closedConversationId,
      subject: "Customer replied",
      changedAt: new Date("2026-08-20T14:00:01.000Z"),
    });
    await recordGmailInboundConversationActivity({
      receptionistId,
      conversationId: escalatedConversationId,
      subject: "Escalated customer replied",
      changedAt: new Date("2026-08-20T14:00:02.000Z"),
    });

    const closedConversation = await getConversation(closedConversationId);
    assert.equal(closedConversation.status, "open");
    assert.equal(closedConversation.subject, "Customer replied");
    const closedAuditEvents = await getAuditEvents(
      receptionistId,
      closedConversationId,
    );
    assert.equal(closedAuditEvents.length, 1);
    assert.deepEqual(closedAuditEvents[0].metadata, {
      previousStatus: "closed",
      status: "open",
      source: "gmail_inbound",
    });

    const escalatedConversation = await getConversation(
      escalatedConversationId,
    );
    assert.equal(escalatedConversation.status, "escalated");
    assert.equal(escalatedConversation.subject, "Escalated customer replied");
    const escalatedAuditEvents = await getAuditEvents(
      receptionistId,
      escalatedConversationId,
    );
    assert.equal(escalatedAuditEvents.length, 0);
  });
});