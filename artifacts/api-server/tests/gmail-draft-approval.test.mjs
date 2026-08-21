import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const outputDirectory = await mkdtemp(
  join(tmpdir(), "siteforge-gmail-approval-"),
);
const outputFile = join(outputDirectory, "gmail-draft-approval.mjs");
const lockOutputFile = join(outputDirectory, "gmail-draft-operation-lock.cjs");
await build({
  entryPoints: [
    new URL("../src/lib/gmail-draft-approval.ts", import.meta.url).pathname,
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outputFile,
  logLevel: "silent",
});
await build({
  stdin: {
    contents: `
      import { sql } from "drizzle-orm";
      import { pool } from "@workspace/db";
      import { withGmailDraftOperationLock } from "./src/lib/gmail-draft-operation-lock.ts";

      export async function withTestDatabaseLock(messageId, operation) {
        return withGmailDraftOperationLock(messageId, async (database) => {
          await database.select({ probe: sql\`1\` });
          return operation();
        });
      }

      export async function closeTestDatabasePool() {
        await pool.end();
      }
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "gmail-draft-operation-lock-test-entry.ts",
  },
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: lockOutputFile,
  logLevel: "silent",
});

const { approveGmailDraft, recoverGmailDraft } = await import(
  pathToFileURL(outputFile).href
);
const { withTestDatabaseLock, closeTestDatabasePool } = await import(
  pathToFileURL(lockOutputFile).href
);

test.after(async () => {
  await closeTestDatabasePool();
});

const now = new Date("2026-08-20T12:00:00.000Z");

function connectorResponse(status, data = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function createHarness({
  approvalState = "pending",
  metadata = { recipientEmail: "customer@example.com" },
  connector,
  currentTime = now,
  markApprovedSucceeds = true,
  markRetryReadySucceeds = true,
} = {}) {
  const state = {
    approvalState,
    metadata: { ...metadata },
  };
  const calls = [];
  const auditEvents = [];
  let operationTail = Promise.resolve();
  const dependencies = {
    runExclusive: async (_messageId, operation) => {
      const predecessor = operationTail;
      let releaseOperation;
      operationTail = new Promise((resolve) => {
        releaseOperation = resolve;
      });
      await predecessor;
      try {
        return await operation(dependencies);
      } finally {
        releaseOperation();
      }
    },
    createConnector: () => ({
      proxy: async (service, path, options) => {
        calls.push({ service, path, options });
        return connector({ service, path, options, calls });
      },
    }),
    getConversation: async () => ({
      id: "conversation-1",
      externalId: "thread-1",
      subject: "Question",
    }),
    claimApproval: async ({ metadata: nextMetadata }) => {
      if (state.approvalState !== "pending") return false;
      state.approvalState = "approving";
      state.metadata = nextMetadata;
      return true;
    },
    claimReconciliation: async ({ metadata: nextMetadata }) => {
      if (state.approvalState !== "approving") return false;
      state.approvalState = "reconciling";
      state.metadata = nextMetadata;
      return true;
    },
    claimRecovery: async ({
      metadata: nextMetadata,
      previousReconciliationToken,
    }) => {
      const currentToken =
        typeof state.metadata.draftReconciliationToken === "string"
          ? state.metadata.draftReconciliationToken
          : null;
      if (
        state.approvalState !== "reconciling" ||
        currentToken !== previousReconciliationToken
      ) {
        return false;
      }
      state.metadata = nextMetadata;
      return true;
    },
    releaseReconciliation: async ({
      metadata: nextMetadata,
      reconciliationToken,
    }) => {
      if (
        state.approvalState !== "reconciling" ||
        state.metadata.draftReconciliationToken !== reconciliationToken
      ) {
        return false;
      }
      state.approvalState = "approving";
      state.metadata = nextMetadata;
      return true;
    },
    markApproved: async ({
      metadata: nextMetadata,
      expectedState,
      reconciliationToken,
    }) => {
      if (
        !markApprovedSucceeds ||
        state.approvalState !== expectedState ||
        (expectedState === "reconciling" &&
          state.metadata.draftReconciliationToken !== reconciliationToken)
      ) {
        return false;
      }
      state.approvalState = "approved";
      state.metadata = nextMetadata;
      return true;
    },
    markRetryReady: async ({ metadata: nextMetadata, reconciliationToken }) => {
      if (
        !markRetryReadySucceeds ||
        state.approvalState !== "reconciling" ||
        state.metadata.draftReconciliationToken !== reconciliationToken
      ) {
        return false;
      }
      state.approvalState = "pending";
      state.metadata = nextMetadata;
      return true;
    },
    audit: async (event) => {
      auditEvents.push(event);
    },
    now: () => new Date(currentTime),
  };

  return {
    state,
    calls,
    auditEvents,
    dependencies,
    message: () => ({
      id: "message-1",
      conversationId: "conversation-1",
      content: "Thanks for getting in touch.",
      approvalState: state.approvalState,
      metadata: { ...state.metadata },
    }),
  };
}

function eventTypes(harness) {
  return harness.auditEvents.map((event) => event.eventType);
}

test("a connector timeout leaves the claim uncertain and never dispatches a second draft", async () => {
  const harness = createHarness({
    connector: async ({ options }) => {
      if (options.method === "POST") throw new Error("connector timeout");
      return connectorResponse(503);
    },
  });

  const initial = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );
  assert.deepEqual(initial, {
    kind: "error",
    status: 502,
    error:
      "Gmail did not confirm the draft. Retry approval shortly to reconcile the attempt safely.",
  });
  assert.equal(harness.state.approvalState, "approving");
  assert.deepEqual(eventTypes(harness), [
    "email_draft_approving",
    "email_draft_approval_uncertain",
  ]);

  const retry = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );
  assert.equal(retry.kind, "error");
  assert.equal(retry.status, 409);
  assert.equal(harness.state.approvalState, "approving");
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    1,
  );
  assert.equal(
    harness.calls.filter((call) => call.options.method === "GET").length,
    1,
  );
});

test("an owner can recover an approval interrupted during the original Gmail POST", async () => {
  const harness = createHarness({
    connector: async ({ options }) => {
      if (options.method === "POST") {
        throw new Error("process interrupted");
      }
      return connectorResponse(200, {
        messages: [{ id: "gmail-message-from-interrupted-post" }],
      });
    },
  });

  const interrupted = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );
  assert.equal(interrupted.kind, "error");
  assert.equal(interrupted.status, 502);
  assert.equal(harness.state.approvalState, "approving");

  const recovery = await recoverGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.deepEqual(recovery, { kind: "approved", gmailDraftId: null });
  assert.equal(harness.state.approvalState, "approved");
  assert.equal(
    harness.state.metadata.gmailMessageId,
    "gmail-message-from-interrupted-post",
  );
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    1,
  );
  assert.equal(
    harness.calls.filter((call) => call.options.method === "GET").length,
    1,
  );
  assert.deepEqual(eventTypes(harness), [
    "email_draft_approving",
    "email_draft_approval_uncertain",
    "email_draft_recovery_started",
    "email_draft_reconciled",
  ]);
});

test("a Gmail 5xx leaves the attempt in reconciliation with its operation key", async () => {
  const harness = createHarness({
    connector: async () => connectorResponse(503),
  });

  const outcome = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 502);
  assert.equal(harness.state.approvalState, "approving");
  assert.equal(harness.state.metadata.draftOperationKey, "siteforge-message-1");
  assert.deepEqual(eventTypes(harness), [
    "email_draft_approving",
    "email_draft_approval_uncertain",
  ]);
  assert.equal(harness.auditEvents[1].metadata.connectorStatus, 503);

  const retry = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );
  assert.equal(retry.kind, "error");
  assert.equal(retry.status, 409);
  assert.equal(harness.state.approvalState, "approving");
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    1,
  );
});

test("a found draft reconciles to approved without another Gmail draft request", async () => {
  const harness = createHarness({
    approvalState: "approving",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:55:00.000Z",
    },
    connector: async () =>
      connectorResponse(200, { messages: [{ id: "gmail-message-1" }] }),
  });

  const outcome = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.deepEqual(outcome, { kind: "approved", gmailDraftId: null });
  assert.equal(harness.state.approvalState, "approved");
  assert.equal(harness.state.metadata.gmailMessageId, "gmail-message-1");
  assert.deepEqual(eventTypes(harness), ["email_draft_reconciled"]);
  assert.equal(harness.calls[0].options.method, "GET");
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    0,
  );
});

test("a found draft stays unresolved when its approved state cannot be persisted", async () => {
  const harness = createHarness({
    approvalState: "approving",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:55:00.000Z",
    },
    markApprovedSucceeds: false,
    connector: async () =>
      connectorResponse(200, { messages: [{ id: "gmail-message-1" }] }),
  });

  const outcome = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, /still being reconciled/i);
  assert.equal(harness.state.approvalState, "reconciling");
  assert.deepEqual(eventTypes(harness), []);
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    0,
  );
});

test("a confirmed absent draft becomes retry-ready, then a new approval is auditable", async () => {
  let draftWasReconciled = false;
  const harness = createHarness({
    approvalState: "approving",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:57:00.000Z",
    },
    connector: async ({ options }) => {
      if (options.method === "GET") {
        draftWasReconciled = true;
        return connectorResponse(200, { messages: [] });
      }
      return connectorResponse(200, {
        id: "gmail-draft-2",
        message: { id: "gmail-message-2" },
      });
    },
  });

  const reconciliation = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );
  assert.equal(reconciliation.kind, "error");
  assert.equal(reconciliation.status, 409);
  assert.equal(draftWasReconciled, true);
  assert.equal(harness.state.approvalState, "pending");
  assert.equal(harness.state.metadata.draftReconciliationResult, "not_found");
  assert.deepEqual(eventTypes(harness), ["email_draft_retry_ready"]);
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    0,
  );

  const retry = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );
  assert.deepEqual(retry, { kind: "approved", gmailDraftId: "gmail-draft-2" });
  assert.equal(harness.state.approvalState, "approved");
  assert.deepEqual(eventTypes(harness), [
    "email_draft_retry_ready",
    "email_draft_approving",
    "email_draft_approved",
  ]);
});

test("a recently absent draft stays in reconciliation until the safety delay passes", async () => {
  const harness = createHarness({
    approvalState: "approving",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:59:00.000Z",
    },
    connector: async () => connectorResponse(200, { messages: [] }),
  });

  const outcome = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, /still being reconciled/i);
  assert.equal(harness.state.approvalState, "approving");
  assert.deepEqual(eventTypes(harness), []);
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    0,
  );
});

test("a failed approved-state write remains uncertain and is never audited as approved", async () => {
  const harness = createHarness({
    markApprovedSucceeds: false,
    connector: async () =>
      connectorResponse(200, {
        id: "gmail-draft-1",
        message: { id: "gmail-message-1" },
      }),
  });

  const outcome = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 502);
  assert.equal(harness.state.approvalState, "approving");
  assert.deepEqual(eventTypes(harness), [
    "email_draft_approving",
    "email_draft_approval_uncertain",
  ]);
  assert.equal(
    harness.auditEvents[1].metadata.reason,
    "approval_state_transition_failed",
  );
});

test("a failed retry-ready write cannot claim that another dispatch is safe", async () => {
  const harness = createHarness({
    approvalState: "approving",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:57:00.000Z",
    },
    markRetryReadySucceeds: false,
    connector: async () => connectorResponse(200, { messages: [] }),
  });

  const outcome = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, /still being reconciled/i);
  assert.equal(harness.state.approvalState, "reconciling");
  assert.deepEqual(eventTypes(harness), []);
});

test("an abandoned reconciliation lock never expires into another Gmail lookup", async () => {
  const harness = createHarness({
    approvalState: "reconciling",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:55:00.000Z",
      draftReconciliationStartedAt: "2026-08-20T11:00:00.000Z",
    },
    connector: async () => {
      throw new Error("No connector lookup should run");
    },
  });

  const outcome = await approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, /still being reconciled/i);
  assert.equal(harness.state.approvalState, "reconciling");
  assert.equal(harness.calls.length, 0);
});

test("an owner can recover a reconciliation abandoned by an interrupted process", async () => {
  const harness = createHarness({
    approvalState: "reconciling",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:55:00.000Z",
      draftReconciliationStartedAt: "2026-08-20T11:56:00.000Z",
    },
    connector: async ({ path, options }) => {
      assert.equal(options.method, "GET");
      assert.match(
        decodeURIComponent(path),
        /rfc822msgid:siteforge-message-1@draft\.local/,
      );
      return connectorResponse(200, {
        messages: [{ id: "gmail-message-recovered" }],
      });
    },
  });

  const outcome = await recoverGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.deepEqual(outcome, { kind: "approved", gmailDraftId: null });
  assert.equal(harness.state.approvalState, "approved");
  assert.equal(
    harness.state.metadata.gmailMessageId,
    "gmail-message-recovered",
  );
  assert.deepEqual(eventTypes(harness), [
    "email_draft_recovery_started",
    "email_draft_reconciled",
  ]);
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    0,
  );
});

test("recovery with a confirmed absent draft reopens approval without dispatching", async () => {
  const harness = createHarness({
    approvalState: "reconciling",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:55:00.000Z",
      draftReconciliationStartedAt: "2026-08-20T11:56:00.000Z",
    },
    connector: async ({ options }) => {
      assert.equal(options.method, "GET");
      return connectorResponse(200, { messages: [] });
    },
  });

  const outcome = await recoverGmailDraft(
    harness.message(),
    harness.dependencies,
  );

  assert.equal(outcome.kind, "error");
  assert.equal(outcome.status, 409);
  assert.match(outcome.error, /ready to retry/i);
  assert.equal(harness.state.approvalState, "pending");
  assert.equal(harness.state.metadata.draftReconciliationResult, "not_found");
  assert.deepEqual(eventTypes(harness), [
    "email_draft_recovery_started",
    "email_draft_retry_ready",
  ]);
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    0,
  );
});

test("concurrent recovery attempts allow only one Gmail lookup", async () => {
  let releaseLookup;
  const lookupReleased = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  let markLookupStarted;
  const lookupStarted = new Promise((resolve) => {
    markLookupStarted = resolve;
  });
  const harness = createHarness({
    approvalState: "reconciling",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:55:00.000Z",
      draftReconciliationStartedAt: "2026-08-20T11:56:00.000Z",
    },
    connector: async ({ options }) => {
      assert.equal(options.method, "GET");
      markLookupStarted();
      await lookupReleased;
      return connectorResponse(200, {
        messages: [{ id: "gmail-message-recovered" }],
      });
    },
  });
  const staleMessage = harness.message();

  const first = recoverGmailDraft(staleMessage, harness.dependencies);
  await lookupStarted;
  const second = recoverGmailDraft(staleMessage, harness.dependencies);

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.state.approvalState, "reconciling");

  releaseLookup();
  const firstOutcome = await first;
  const secondOutcome = await second;
  assert.deepEqual(firstOutcome, { kind: "approved", gmailDraftId: null });
  assert.equal(secondOutcome.kind, "error");
  assert.equal(secondOutcome.status, 409);
  assert.equal(harness.state.approvalState, "approved");
  assert.equal(harness.calls.length, 1);
});

test("recovery cannot overlap a stale lookup and reopen approval", async () => {
  let releaseStaleLookup;
  const staleLookupReleased = new Promise((resolve) => {
    releaseStaleLookup = resolve;
  });
  let markStaleLookupStarted;
  const staleLookupStarted = new Promise((resolve) => {
    markStaleLookupStarted = resolve;
  });
  let lookupCount = 0;
  const harness = createHarness({
    approvalState: "approving",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:55:00.000Z",
    },
    connector: async ({ options }) => {
      assert.equal(options.method, "GET");
      lookupCount += 1;
      if (lookupCount === 1) {
        markStaleLookupStarted();
        await staleLookupReleased;
        return connectorResponse(200, {
          messages: [{ id: "gmail-message-existing" }],
        });
      }
      return connectorResponse(200, { messages: [] });
    },
  });

  const staleAttempt = approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );
  await staleLookupStarted;
  const recoveryMessage = harness.message();
  const recovery = recoverGmailDraft(recoveryMessage, harness.dependencies);

  assert.equal(lookupCount, 1);
  assert.equal(harness.state.approvalState, "reconciling");

  releaseStaleLookup();
  const staleOutcome = await staleAttempt;
  const recoveryOutcome = await recovery;
  assert.deepEqual(staleOutcome, { kind: "approved", gmailDraftId: null });
  assert.equal(recoveryOutcome.kind, "error");
  assert.equal(recoveryOutcome.status, 409);
  assert.equal(harness.state.approvalState, "approved");
  assert.equal(lookupCount, 1);
  assert.deepEqual(eventTypes(harness), ["email_draft_reconciled"]);
});

test("concurrent reconciliation cannot let not-found override a found draft", async () => {
  let releaseFoundLookup;
  const foundLookupReleased = new Promise((resolve) => {
    releaseFoundLookup = resolve;
  });
  let markFoundLookupStarted;
  const foundLookupStarted = new Promise((resolve) => {
    markFoundLookupStarted = resolve;
  });
  let lookupCount = 0;
  const harness = createHarness({
    approvalState: "approving",
    metadata: {
      recipientEmail: "customer@example.com",
      draftOperationKey: "siteforge-message-1",
      draftAttemptStartedAt: "2026-08-20T11:55:00.000Z",
    },
    connector: async ({ options }) => {
      assert.equal(options.method, "GET");
      lookupCount += 1;
      if (lookupCount === 1) {
        markFoundLookupStarted();
        await foundLookupReleased;
        return connectorResponse(200, {
          messages: [{ id: "gmail-message-1" }],
        });
      }
      return connectorResponse(200, { messages: [] });
    },
  });
  const staleMessage = harness.message();

  const foundAttempt = approveGmailDraft(staleMessage, harness.dependencies);
  await foundLookupStarted;
  const competingAttempt = approveGmailDraft(
    staleMessage,
    harness.dependencies,
  );

  assert.equal(harness.state.approvalState, "reconciling");
  assert.equal(lookupCount, 1);

  releaseFoundLookup();
  const foundOutcome = await foundAttempt;
  const competingOutcome = await competingAttempt;
  assert.deepEqual(foundOutcome, { kind: "approved", gmailDraftId: null });
  assert.equal(competingOutcome.kind, "error");
  assert.equal(competingOutcome.status, 409);
  assert.equal(harness.state.approvalState, "approved");
  assert.deepEqual(eventTypes(harness), ["email_draft_reconciled"]);
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    0,
  );
});

test("concurrent approvals let only the first request create a Gmail draft", async () => {
  let releaseDraftRequest;
  const draftRequestReleased = new Promise((resolve) => {
    releaseDraftRequest = resolve;
  });
  let markDraftRequestStarted;
  const draftRequestStarted = new Promise((resolve) => {
    markDraftRequestStarted = resolve;
  });
  const harness = createHarness({
    connector: async ({ options }) => {
      assert.equal(options.method, "POST");
      markDraftRequestStarted();
      await draftRequestReleased;
      return connectorResponse(200, {
        id: "gmail-draft-1",
        message: { id: "gmail-message-1" },
      });
    },
  });

  const first = approveGmailDraft(harness.message(), harness.dependencies);
  await draftRequestStarted;
  const second = approveGmailDraft(
    {
      id: "message-1",
      conversationId: "conversation-1",
      content: "Thanks for getting in touch.",
      approvalState: "pending",
      metadata: { recipientEmail: "customer@example.com" },
    },
    harness.dependencies,
  );

  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    1,
  );

  releaseDraftRequest();
  const firstOutcome = await first;
  const secondOutcome = await second;
  assert.deepEqual(firstOutcome, {
    kind: "approved",
    gmailDraftId: "gmail-draft-1",
  });
  assert.deepEqual(secondOutcome, {
    kind: "error",
    status: 409,
    error: "This suggestion is already being processed.",
  });
  assert.equal(harness.state.approvalState, "approved");
  assert.deepEqual(eventTypes(harness), [
    "email_draft_approving",
    "email_draft_approved",
  ]);
});

test("a delayed original Gmail POST cannot overlap reconciliation or reopen approval", async () => {
  let releaseDraftRequest;
  const draftRequestReleased = new Promise((resolve) => {
    releaseDraftRequest = resolve;
  });
  let markDraftRequestStarted;
  const draftRequestStarted = new Promise((resolve) => {
    markDraftRequestStarted = resolve;
  });
  const harness = createHarness({
    connector: async ({ options }) => {
      if (options.method === "POST") {
        markDraftRequestStarted();
        await draftRequestReleased;
        return connectorResponse(200, {
          id: "gmail-draft-1",
          message: { id: "gmail-message-1" },
        });
      }
      return connectorResponse(200, { messages: [] });
    },
  });

  const originalAttempt = approveGmailDraft(
    harness.message(),
    harness.dependencies,
  );
  await draftRequestStarted;
  const reconciliationMessage = harness.message();
  assert.equal(reconciliationMessage.approvalState, "approving");
  const reconciliationAttempt = approveGmailDraft(
    reconciliationMessage,
    harness.dependencies,
  );

  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].options.method, "POST");
  assert.equal(harness.state.approvalState, "approving");

  releaseDraftRequest();
  const originalOutcome = await originalAttempt;
  const reconciliationOutcome = await reconciliationAttempt;

  assert.deepEqual(originalOutcome, {
    kind: "approved",
    gmailDraftId: "gmail-draft-1",
  });
  assert.equal(reconciliationOutcome.kind, "error");
  assert.equal(reconciliationOutcome.status, 409);
  assert.equal(harness.state.approvalState, "approved");
  assert.equal(
    harness.calls.filter((call) => call.options.method === "POST").length,
    1,
  );
  assert.equal(
    harness.calls.filter((call) => call.options.method === "GET").length,
    0,
  );
});

test("the PostgreSQL operation lock serializes separate sessions for one suggestion", async () => {
  const messageId = `gmail-lock-${process.pid}-${Date.now()}`;
  let releaseFirst;
  const firstReleased = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  let secondStarted = false;

  const first = withTestDatabaseLock(messageId, async () => {
    markFirstStarted();
    await firstReleased;
  });
  await firstStarted;
  const second = withTestDatabaseLock(messageId, async () => {
    secondStarted = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(secondStarted, false);

  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
});

test("dedicated lock sessions do not starve the database pool", async () => {
  const prefix = `gmail-pool-${process.pid}-${Date.now()}`;
  await Promise.race([
    Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        withTestDatabaseLock(`${prefix}-${index}`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }),
      ),
    ),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("database pool starved while locks were held")),
        2_000,
      ),
    ),
  ]);
});
