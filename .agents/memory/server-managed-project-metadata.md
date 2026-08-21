---
name: Server-managed project metadata
description: Preserving protected lifecycle metadata when editable project documents round-trip through generated API schemas and autosave.
---

Optional metadata embedded in an editable project must be represented in the shared API contract, even when clients are not allowed to control it. On saves, restore the authoritative stored value for protected project types and strip caller-supplied values from ordinary projects.

**Why:** Generated validators can silently strip fields absent from the API schema. A Studio autosave then replaces the full document without the protected metadata, breaking later lifecycle validation even though the separate database type marker remains correct.

**How to apply:** Whenever server-managed metadata lives inside a client-editable document, include its read shape in response/request schemas for lossless round-tripping, but enforce write authority under the same row lock used for optimistic revision checks.