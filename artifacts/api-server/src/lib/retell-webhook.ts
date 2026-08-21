import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1_000;
const SIGNATURE_PATTERN = /^v=(\d+),d=([a-fA-F0-9]{64})$/;

export type RetellTranscriptUtterance = {
  role: string;
  content: string;
};

export type RetellCall = {
  call_id: string;
  agent_id?: string;
  transcript_object?: RetellTranscriptUtterance[];
  recording_url?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  call_status?: string;
  call_analysis?: Record<string, unknown>;
};

export type RetellSignatureResult =
  | { valid: true; timestamp: number }
  | {
      valid: false;
      reason:
        | "missing_signature"
        | "malformed_signature"
        | "stale_signature"
        | "invalid_signature";
      timestamp?: number;
    };

export type RetellWebhookPayloadResult =
  | { kind: "call_ended"; call: RetellCall }
  | { kind: "ignored"; event: string }
  | { kind: "invalid"; reason: "invalid_json" | "invalid_payload" };

export function hashRetellWebhookPayload(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export function verifyRetellWebhookSignature(
  rawBody: string,
  apiKey: string,
  signature: string | undefined,
  nowMs = Date.now(),
): RetellSignatureResult {
  if (!signature) {
    return { valid: false, reason: "missing_signature" };
  }

  const match = SIGNATURE_PATTERN.exec(signature);
  if (!match) {
    return { valid: false, reason: "malformed_signature" };
  }

  const timestampText = match[1];
  const digestText = match[2];
  if (!timestampText || !digestText) {
    return { valid: false, reason: "malformed_signature" };
  }

  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowMs - timestamp) > MAX_SIGNATURE_AGE_MS
  ) {
    return { valid: false, reason: "stale_signature", timestamp };
  }

  const expectedDigest = createHmac("sha256", apiKey)
    .update(`${rawBody}${timestampText}`, "utf8")
    .digest();
  const suppliedDigest = Buffer.from(digestText, "hex");

  if (
    suppliedDigest.length !== expectedDigest.length ||
    !timingSafeEqual(expectedDigest, suppliedDigest)
  ) {
    return { valid: false, reason: "invalid_signature", timestamp };
  }

  return { valid: true, timestamp };
}

export function parseRetellWebhookPayload(
  rawBody: string,
): RetellWebhookPayloadResult {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { kind: "invalid", reason: "invalid_json" };
  }

  if (!isRecord(payload) || typeof payload.event !== "string") {
    return { kind: "invalid", reason: "invalid_payload" };
  }

  if (payload.event !== "call_ended") {
    return { kind: "ignored", event: payload.event };
  }

  const call = parseCall(payload.call);
  if (!call || !call.agent_id) {
    return { kind: "invalid", reason: "invalid_payload" };
  }

  return { kind: "call_ended", call };
}

function parseCall(value: unknown): RetellCall | null {
  if (!isRecord(value) || !isNonEmptyString(value.call_id)) {
    return null;
  }
  if (value.agent_id !== undefined && !isNonEmptyString(value.agent_id)) {
    return null;
  }
  if (
    value.recording_url !== undefined &&
    typeof value.recording_url !== "string"
  ) {
    return null;
  }
  if (!isOptionalFiniteNumber(value.start_timestamp)) {
    return null;
  }
  if (!isOptionalFiniteNumber(value.end_timestamp)) {
    return null;
  }
  if (
    value.call_status !== undefined &&
    typeof value.call_status !== "string"
  ) {
    return null;
  }
  if (value.call_analysis !== undefined && !isRecord(value.call_analysis)) {
    return null;
  }

  let transcript: RetellTranscriptUtterance[] | undefined;
  if (value.transcript_object !== undefined) {
    if (!Array.isArray(value.transcript_object)) {
      return null;
    }
    transcript = [];
    for (const utterance of value.transcript_object) {
      if (
        !isRecord(utterance) ||
        typeof utterance.role !== "string" ||
        typeof utterance.content !== "string"
      ) {
        return null;
      }
      transcript.push({
        role: utterance.role,
        content: utterance.content,
      });
    }
  }

  return {
    call_id: value.call_id,
    agent_id: value.agent_id,
    transcript_object: transcript,
    recording_url: value.recording_url,
    start_timestamp: value.start_timestamp,
    end_timestamp: value.end_timestamp,
    call_status: value.call_status,
    call_analysis: value.call_analysis,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalFiniteNumber(
  value: unknown,
): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}