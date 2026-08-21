---
name: One-time secret submission
description: Reliable handling of transient setup keys and other secret form inputs in generated React Query clients.
---

Pass one-time secret values directly to the API call at submission time rather than binding them into mutable request options supplied to a long-lived mutation hook. Surface the server's sanitized error message to distinguish invalid credentials from conflicts or validation failures.

**Why:** A controlled secret field appeared correct in the UI while repeated submissions reached the server with a stale value, producing misleading generic failures.

**How to apply:** Use the current in-memory field value only for the immediate request, clear it after success, never persist it in project state, and verify the outgoing header with a harmless placeholder in browser tests.