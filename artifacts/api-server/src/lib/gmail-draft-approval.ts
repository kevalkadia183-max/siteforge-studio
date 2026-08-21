import { randomUUID } from "node:crypto";

export type GmailDraftConnector = {
  proxy(
    service: string,
    path: string,
    options: {
      method: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
};

export type GmailDraftApprovalMessage = {
  id: string;
  conversationId: string;
  content: string;
  approvalState: string | null;
  metadata: Record<string, unknown> | null;
};

export type GmailDraftApprovalConversation = {
  id: string;
  externalId: string | null;
  subject: string | null;
};

type AuditEvent = {
  eventType: string;
  metadata: Record<string, unknown>;
};

export type GmailDraftApprovalDependencies = {
  runExclusive<T>(
    messageId: string,
    operation: (dependencies: GmailDraftApprovalDependencies) => Promise<T>,
  ): Promise<T>;
  createConnector(): GmailDraftConnector;
  getConversation(): Promise<GmailDraftApprovalConversation | null>;
  claimApproval(input: {
    operationKey: string;
    attemptedAt: string;
    metadata: Record<string, unknown>;
  }): Promise<boolean>;
  claimReconciliation(input: {
    metadata: Record<string, unknown>;
    reconciliationToken: string;
  }): Promise<boolean>;
  claimRecovery(input: {
    metadata: Record<string, unknown>;
    previousReconciliationToken: string | null;
    reconciliationToken: string;
  }): Promise<boolean>;
  releaseReconciliation(input: {
    metadata: Record<string, unknown>;
    reconciliationToken: string;
  }): Promise<boolean>;
  markApproved(input: {
    metadata: Record<string, unknown>;
    expectedState: "approving" | "reconciling";
    reconciliationToken?: string;
  }): Promise<boolean>;
  markRetryReady(input: {
    metadata: Record<string, unknown>;
    reconciliationToken: string;
  }): Promise<boolean>;
  audit(event: AuditEvent): Promise<void>;
  now(): Date;
  warn?(message: string, details?: Record<string, unknown>): void;
  error?(message: string, details?: Record<string, unknown>): void;
};

export type GmailDraftApprovalOutcome =
  | {
      kind: "approved";
      gmailDraftId: string | null;
    }
  | {
      kind: "error";
      status: 404 | 409 | 502;
      error: string;
    };

const draftReconciliationDelayMs = 2 * 60 * 1000;

function getOperationKey(message: GmailDraftApprovalMessage): string {
  const existing = message.metadata?.["draftOperationKey"];
  return typeof existing === "string" ? existing : `siteforge-${message.id}`;
}

function getReconciliationToken(
  metadata: Record<string, unknown>,
): string | null {
  const token = metadata["draftReconciliationToken"];
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function auditSafely(
  dependencies: GmailDraftApprovalDependencies,
  event: AuditEvent,
): Promise<void> {
  try {
    await dependencies.audit(event);
  } catch (error) {
    dependencies.error?.("Failed to audit Gmail draft approval state", {
      error: String(error),
      eventType: event.eventType,
    });
  }
}

async function findDraftMessageByOperationKey(
  connector: GmailDraftConnector,
  operationKey: string,
): Promise<
  | { status: "found"; gmailMessageId: string }
  | { status: "not_found" }
  | { status: "unavailable" }
> {
  const query = encodeURIComponent(
    `in:drafts rfc822msgid:${operationKey}@draft.local`,
  );
  const response = await connector.proxy(
    "google-mail",
    `/gmail/v1/users/me/messages?q=${query}&maxResults=1`,
    { method: "GET" },
  );
  if (!response.ok) return { status: "unavailable" };

  const data = (await response.json()) as {
    messages?: Array<{ id?: string }>;
  };
  const gmailMessageId = data.messages?.[0]?.id;
  return gmailMessageId
    ? { status: "found", gmailMessageId }
    : { status: "not_found" };
}

async function reconcileClaimedDraft(
  message: GmailDraftApprovalMessage,
  dependencies: GmailDraftApprovalDependencies,
  connector: GmailDraftConnector,
  operationKey: string,
  reconciliationToken: string,
  releaseOnUnavailable: boolean,
): Promise<GmailDraftApprovalOutcome> {
  const metadata = message.metadata ?? {};
  let lookup:
    Awaited<ReturnType<typeof findDraftMessageByOperationKey>> | undefined;
  try {
    lookup = await findDraftMessageByOperationKey(connector, operationKey);
  } catch (error) {
    dependencies.warn?.("Gmail draft reconciliation failed", {
      error: String(error),
    });
  }

  if (!lookup || lookup.status === "unavailable") {
    if (releaseOnUnavailable) {
      await dependencies.releaseReconciliation({
        metadata,
        reconciliationToken,
      });
    }
    return {
      kind: "error",
      status: 409,
      error:
        "The earlier Gmail draft attempt is still being reconciled. Try again shortly.",
    };
  }

  if (lookup.status === "found") {
    const reconciled = await dependencies.markApproved({
      expectedState: "reconciling",
      reconciliationToken,
      metadata: {
        ...metadata,
        draftOperationKey: operationKey,
        gmailMessageId: lookup.gmailMessageId,
        draftReconciledAt: dependencies.now().toISOString(),
      },
    });
    if (!reconciled) {
      return {
        kind: "error",
        status: 409,
        error:
          "The earlier Gmail draft attempt is still being reconciled. Try again shortly.",
      };
    }
    await auditSafely(dependencies, {
      eventType: "email_draft_reconciled",
      metadata: { operationKey, gmailMessageId: lookup.gmailMessageId },
    });
    return { kind: "approved", gmailDraftId: null };
  }

  const attemptedAt =
    typeof metadata["draftAttemptStartedAt"] === "string"
      ? Date.parse(metadata["draftAttemptStartedAt"])
      : Number.NaN;
  if (
    Number.isFinite(attemptedAt) &&
    dependencies.now().getTime() - attemptedAt >= draftReconciliationDelayMs
  ) {
    const retryReady = await dependencies.markRetryReady({
      reconciliationToken,
      metadata: {
        ...metadata,
        draftOperationKey: operationKey,
        draftReconciledAt: dependencies.now().toISOString(),
        draftReconciliationResult: "not_found",
      },
    });
    if (retryReady) {
      await auditSafely(dependencies, {
        eventType: "email_draft_retry_ready",
        metadata: { operationKey, reconciliationResult: "not_found" },
      });
      return {
        kind: "error",
        status: 409,
        error:
          "No Gmail draft was found for the earlier attempt. Approval is ready to retry.",
      };
    }
    return {
      kind: "error",
      status: 409,
      error:
        "The earlier Gmail draft attempt is still being reconciled. Try again shortly.",
    };
  }

  if (releaseOnUnavailable) {
    await dependencies.releaseReconciliation({
      metadata,
      reconciliationToken,
    });
  }
  return {
    kind: "error",
    status: 409,
    error:
      "The earlier Gmail draft attempt is still being reconciled. Try again shortly.",
  };
}

async function recoverGmailDraftExclusive(
  message: GmailDraftApprovalMessage,
  dependencies: GmailDraftApprovalDependencies,
): Promise<GmailDraftApprovalOutcome> {
  if (
    message.approvalState !== "approving" &&
    message.approvalState !== "reconciling"
  ) {
    return {
      kind: "error",
      status: 409,
      error: "This suggestion is not awaiting Gmail draft recovery.",
    };
  }

  const metadata = message.metadata ?? {};
  const reconciliationToken = randomUUID();
  const operationKey = getOperationKey(message);
  const reconciliationMetadata = {
    ...metadata,
    draftOperationKey: operationKey,
    draftReconciliationToken: reconciliationToken,
    draftReconciliationStartedAt: dependencies.now().toISOString(),
    draftRecoveryStartedAt: dependencies.now().toISOString(),
  };
  const claimed =
    message.approvalState === "approving"
      ? await dependencies.claimReconciliation({
          reconciliationToken,
          metadata: reconciliationMetadata,
        })
      : await dependencies.claimRecovery({
          previousReconciliationToken: getReconciliationToken(metadata),
          reconciliationToken,
          metadata: reconciliationMetadata,
        });
  if (!claimed) {
    return {
      kind: "error",
      status: 409,
      error:
        "The earlier Gmail draft attempt is still being reconciled. Try again shortly.",
    };
  }

  await auditSafely(dependencies, {
    eventType: "email_draft_recovery_started",
    metadata: { operationKey },
  });
  return reconcileClaimedDraft(
    message,
    dependencies,
    dependencies.createConnector(),
    operationKey,
    reconciliationToken,
    false,
  );
}

export async function recoverGmailDraft(
  message: GmailDraftApprovalMessage,
  dependencies: GmailDraftApprovalDependencies,
): Promise<GmailDraftApprovalOutcome> {
  return dependencies.runExclusive(message.id, (scopedDependencies) =>
    recoverGmailDraftExclusive(message, scopedDependencies),
  );
}

async function approveGmailDraftExclusive(
  message: GmailDraftApprovalMessage,
  dependencies: GmailDraftApprovalDependencies,
): Promise<GmailDraftApprovalOutcome> {
  const metadata = message.metadata ?? {};
  const operationKey = getOperationKey(message);
  const connector = dependencies.createConnector();

  if (message.approvalState === "approved") {
    return {
      kind: "approved",
      gmailDraftId:
        typeof metadata["gmailDraftId"] === "string"
          ? metadata["gmailDraftId"]
          : null,
    };
  }

  if (message.approvalState === "reconciling") {
    return {
      kind: "error",
      status: 409,
      error:
        "The earlier Gmail draft attempt is still being reconciled. Try again shortly.",
    };
  }

  if (message.approvalState === "approving") {
    const reconciliationToken = randomUUID();
    const reconciliationMetadata = {
      ...metadata,
      draftReconciliationToken: reconciliationToken,
      draftReconciliationStartedAt: dependencies.now().toISOString(),
    };
    const claimedReconciliation = await dependencies.claimReconciliation({
      metadata: reconciliationMetadata,
      reconciliationToken,
    });
    if (!claimedReconciliation) {
      return {
        kind: "error",
        status: 409,
        error:
          "The earlier Gmail draft attempt is still being reconciled. Try again shortly.",
      };
    }

    return reconcileClaimedDraft(
      message,
      dependencies,
      connector,
      operationKey,
      reconciliationToken,
      true,
    );
  }

  if (message.approvalState !== "pending") {
    return {
      kind: "error",
      status: 409,
      error: "This suggestion is not pending approval.",
    };
  }

  const conversation = await dependencies.getConversation();
  if (!conversation) {
    return { kind: "error", status: 404, error: "Conversation not found." };
  }

  const recipientEmail =
    typeof metadata["recipientEmail"] === "string"
      ? metadata["recipientEmail"]
      : null;
  if (!recipientEmail) {
    return {
      kind: "error",
      status: 409,
      error:
        "The sender address is unavailable, so this draft cannot be created safely.",
    };
  }

  const attemptedAt = dependencies.now().toISOString();
  const claimed = await dependencies.claimApproval({
    operationKey,
    attemptedAt,
    metadata: {
      ...metadata,
      draftOperationKey: operationKey,
      draftAttemptStartedAt: attemptedAt,
    },
  });
  if (!claimed) {
    return {
      kind: "error",
      status: 409,
      error: "This suggestion is already being processed.",
    };
  }

  await auditSafely(dependencies, {
    eventType: "email_draft_approving",
    metadata: { operationKey },
  });

  const subject = conversation.subject ?? "Re: (No subject)";
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const rfc2822 = [
    `To: ${recipientEmail}`,
    `Subject: ${replySubject}`,
    `Message-ID: <${operationKey}@draft.local>`,
    `Content-Type: text/plain; charset=UTF-8`,
    "",
    message.content,
  ].join("\r\n");
  const draftBody: Record<string, unknown> = {
    message: {
      raw: Buffer.from(rfc2822).toString("base64url"),
      ...(conversation.externalId ? { threadId: conversation.externalId } : {}),
    },
  };

  try {
    const draftResponse = await connector.proxy(
      "google-mail",
      "/gmail/v1/users/me/drafts",
      {
        method: "POST",
        body: draftBody,
        headers: { "Content-Type": "application/json" },
      },
    );
    if (!draftResponse.ok) {
      await auditSafely(dependencies, {
        eventType: "email_draft_approval_uncertain",
        metadata: { operationKey, connectorStatus: draftResponse.status },
      });
      dependencies.warn?.("Gmail draft creation failed", {
        status: draftResponse.status,
      });
      return {
        kind: "error",
        status: 502,
        error:
          "Gmail did not confirm the draft. Retry approval shortly to reconcile the attempt safely.",
      };
    }

    const draftData = (await draftResponse.json()) as {
      id?: string;
      message?: { id?: string };
    };
    const gmailDraftId = draftData.id ?? null;
    const approved = await dependencies.markApproved({
      expectedState: "approving",
      metadata: {
        ...metadata,
        draftOperationKey: operationKey,
        gmailDraftId,
        gmailMessageId: draftData.message?.id ?? null,
        draftApprovedAt: dependencies.now().toISOString(),
      },
    });
    if (!approved) {
      await auditSafely(dependencies, {
        eventType: "email_draft_approval_uncertain",
        metadata: {
          operationKey,
          gmailDraftId,
          reason: "approval_state_transition_failed",
        },
      });
      return {
        kind: "error",
        status: 502,
        error:
          "Gmail did not confirm the draft. Retry approval shortly to reconcile the attempt safely.",
      };
    }
    await auditSafely(dependencies, {
      eventType: "email_draft_approved",
      metadata: { operationKey, gmailDraftId },
    });
    return { kind: "approved", gmailDraftId };
  } catch (error) {
    await auditSafely(dependencies, {
      eventType: "email_draft_approval_uncertain",
      metadata: { operationKey },
    });
    dependencies.error?.("Gmail draft creation error", {
      error: String(error),
    });
    return {
      kind: "error",
      status: 502,
      error:
        "Gmail did not confirm the draft. Retry approval shortly to reconcile the attempt safely.",
    };
  }
}

export async function approveGmailDraft(
  message: GmailDraftApprovalMessage,
  dependencies: GmailDraftApprovalDependencies,
): Promise<GmailDraftApprovalOutcome> {
  return dependencies.runExclusive(message.id, (scopedDependencies) =>
    approveGmailDraftExclusive(message, scopedDependencies),
  );
}
