---
name: Sandbox-safe preview widgets
description: How generated client widgets must behave when SiteForge previews deny storage and native form submission.
---

Generated chat widgets must treat browser session storage and native form submission as optional. If a sandbox denies storage access, widget bootstrap must continue with in-memory session state for the active page. Interactive widget actions must use explicit JavaScript handlers rather than depending on native form submission.

**Why:** SiteForge public previews and Studio iframes intentionally use opaque-origin sandboxes without form permission. Reading `sessionStorage` can throw a `SecurityError`, and a native form submission can be blocked before the widget sends its request.

**How to apply:** Keep storage access behind exception-safe helpers, preserve sessions in page memory, and use explicit button/keyboard handlers for widget requests. Do not add `allow-same-origin` or `allow-forms` as a workaround.