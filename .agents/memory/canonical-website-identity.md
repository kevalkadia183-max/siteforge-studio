---
name: Canonical website identity
description: Why website record identity must override identity embedded in editable project source.
---

Treat the database website row's `id` and `name` as canonical whenever a project is duplicated, serialized, or hydrated. A copied `projectSource` must be rewritten to the new row identity, and clients should normalize it defensively before caching or editing.

**Why:** An end-to-end duplicate flow exposed that copying editable source unchanged can leave the new row carrying the original project's embedded ID. That creates duplicate UI keys and can route later saves to the wrong website.

**How to apply:** Any new server operation that copies or reconstructs website source must overlay the destination row identity after sanitization. Any client hydration path must prefer record metadata over embedded identity before merging local-only cache fields.