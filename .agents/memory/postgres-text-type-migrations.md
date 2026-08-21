---
name: PostgreSQL text type migrations
description: Safe forward migrations when correcting PostgreSQL text columns to typed integer or boolean columns.
---

When changing an existing PostgreSQL text column to integer or boolean, use an explicit forward SQL migration with guarded `USING` expressions. Drop an incompatible text default before changing a column to boolean, then restore the typed default afterward. Do not rely on schema push to infer these conversions.

**Why:** Schema push attempts the direct type change without the required `USING` clause, while PostgreSQL also rejects a boolean conversion if the old text default remains attached. Unguarded casts can fail on legacy blank or malformed rows.

**How to apply:** Normalize or safely map legacy values in a `CASE` expression, bound numeric values to the target domain, apply the conversion transactionally, and rerun schema push afterward only to confirm the live schema matches.