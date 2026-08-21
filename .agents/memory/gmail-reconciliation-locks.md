---
name: Gmail reconciliation locks
description: Safety rule for ambiguous Gmail draft attempts and concurrent reconciliation.
---

An ambiguous Gmail draft attempt must stay locked until one serialized reconciliation confirms either presence or absence. Do not auto-expire an in-flight reconciliation lock. The initial Gmail POST and every later reconciliation or recovery lookup must share a process-death-safe operation lock.

**Why:** An expiring lock can let an old lookup that finds a draft overlap a replacement lookup that reports not found. The replacement can reopen approval and permit a duplicate Gmail draft before the older positive result is persisted. The same risk exists if reconciliation overlaps an unconfirmed, delayed draft POST.

**How to apply:** Use one checked-out database session for the operation lock and every state transition; holding a pooled lock session while querying through the global pool can self-starve. When edits, opt-outs, discards, or replies can invalidate the reviewed copy or authorization, share one lead-wide lock across every mutation and the provider side effect. Persist the pre-POST claim independently so it survives process death. Claim reconciliation atomically before querying Gmail and fence its writes with an ownership token. Only the claimant may transition to approved or retry-ready. If a worker disappears in either approving or reconciling, fail closed until owner-initiated recovery obtains the same lock and proves presence or absence by operation key. A negative lookup becomes retry-ready only after a safety delay and a separate owner action; never turn an ambiguous result directly into another provider POST.