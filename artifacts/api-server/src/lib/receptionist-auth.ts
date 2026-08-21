import { createHash, randomBytes } from "node:crypto";

export function newOpaqueId(): string {
  return randomBytes(16).toString("hex");
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
