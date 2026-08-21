---
name: Retell webhook verification
description: Security boundary for receiving Retell lifecycle events.
---

Retell webhook authentication must use the exact raw request bytes together with the dedicated Retell API key that is enabled for webhooks. The outbound Retell connector is not a substitute for that key.

**Why:** Retell signs the raw body plus a timestamp; parsing or reserializing it changes the signed representation. Connector credentials support outbound API calls but cannot authenticate inbound Retell deliveries.

**How to apply:** Keep the webhook route ahead of global JSON parsing, enforce Retell's five-minute signature window, and fail closed when the dedicated webhook secret is unavailable. Treat provider delivery keys and the database transaction as the replay/idempotency boundary.