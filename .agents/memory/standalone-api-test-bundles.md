---
name: Standalone API test bundles
description: Pino worker requirements when a Node test bundles and starts the complete API application.
---

Standalone tests that bundle the complete API application must produce Pino's companion worker files, not only the main test bundle.

**Why:** Pino's development transport starts workers asynchronously. If the companion bundles are absent, HTTP assertions can all pass before Node reports uncaught worker errors during teardown and fails the test file.

**How to apply:** When an API-level test imports the full app through Esbuild, mirror the API build's Pino plugin and multi-output setup. Ensure the plugin can resolve CommonJS packages during build setup.