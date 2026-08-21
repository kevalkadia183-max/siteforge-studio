---
name: Escalation status transitions
description: Concurrency and source-of-change rules for resolving, reopening, and preserving receptionist escalations.
---

Owner-driven resolve or reopen actions must carry a freshness precondition and lock the conversation while checking it, changing status, and writing the audit event. A stale owner view must fail closed rather than resolve activity that arrived afterward.

**Why:** Checking only the status read inside the mutation handler cannot detect that the owner acted on an older inbox view. A newer public escalation could otherwise be closed without the owner seeing it.

**How to apply:** Treat status transition plus audit as one transaction. Advance conversation freshness atomically when accepting inbound activity, before asynchronous AI work. Public messages may raise escalation but never clear it. New inbound activity may reopen a resolved thread only when its current status is closed; escalated remains escalated.