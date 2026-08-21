import { db, receptionistAuditEventsTable } from "@workspace/db";
import { newOpaqueId } from "./receptionist-auth";

export async function recordRejectedRetellWebhook(
  metadata: Record<string, unknown>,
) {
  await db.insert(receptionistAuditEventsTable).values({
    id: newOpaqueId(),
    receptionistId: null,
    eventType: "retell_webhook_rejected",
    metadata,
  });
}