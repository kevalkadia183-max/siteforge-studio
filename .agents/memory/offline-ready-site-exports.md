---
name: Offline-ready site exports
description: Policy for keeping generated client website packages portable and dependency-free.
---

Generated client website ZIPs must not depend on external runtime stylesheets, scripts, fonts, or CDNs. Bundle required assets into the package, or use local-safe system alternatives.

**Why:** Client handoff packages need to work after extraction, on basic static hosting, and under restrictive network or content-security conditions.

**How to apply:** Treat any external runtime URL in generated HTML, CSS, or JavaScript as a release blocker unless the user explicitly changes the export policy.