---
name: Orval Zod integer compatibility
description: Compatibility rule for integer fields in the generated Zod API package.
---

With the workspace's current Orval and Zod versions, OpenAPI `integer` fields can generate `zod.int()`, which is unavailable in the installed Zod runtime. Model safe JavaScript numeric values as OpenAPI `number` and enforce integer semantics at the server boundary.

**Why:** Code generation succeeded but the generated Zod package failed TypeScript compilation because `zod.int()` did not exist.

**How to apply:** For timestamps or other safe numeric values that require integers, use `type: number` in the API spec and add an explicit `Number.isSafeInteger` validation in the route.