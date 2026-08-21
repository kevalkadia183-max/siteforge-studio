---
name: Browser concurrency test isolation
description: Reliability rules for browser tests that exercise simultaneous authenticated edits in one shared environment.
---

Concurrency tests must synchronize on the exact mutation response, not on a status label that may already show its settled value before an edit begins. Parallel runs also need collision-resistant identities that remain valid for the provider’s identifier format and separate runner output directories.

**Why:** A pre-existing “Saved” label can let the stale session act before the first write commits, reversing which session conflicts. Parallel Playwright processes can also corrupt shared trace output, and otherwise-unique email identifiers can exceed provider format limits.

**How to apply:** For multi-session tests, install response waiters before triggering each mutation, scope temporary data to one cryptographically unique owner, keep generated identifiers within provider limits, isolate each process’s test artifacts, and verify the suite with concurrent invocations.