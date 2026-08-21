---
name: Development schema readiness
description: Why authenticated SiteForge Studio checks may fail before the UI renders in a partially initialized development database.
---

Before authenticated Studio browser tests, verify the development database has the current project schema when account bootstrap fails on a missing relation.

**Why:** A task worktree had current schema definitions but only part of that schema in the shared development database. Clerk sign-in succeeded, but account bootstrap failed before the Studio rendered.

**How to apply:** Confirm database reachability and inspect the development schema. If current project tables are absent, use the repository's supported development schema push before retrying; never add startup-time DDL or custom production migrations.