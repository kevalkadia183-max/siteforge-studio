---
name: Receptionist policy boundary
description: Safety invariant separating request authorization from free-form business knowledge.
---

Only canonical, typed safe intents may authorize an automated receptionist reply. Free-form knowledge and FAQ facts may provide bounded answer content after authorization, but their words must never make a request eligible.

**Why:** Using fact-token overlap to authorize requests let transactional or regulated wording become “safe” whenever the same wording appeared in an owner fact. This repeatedly created mixed-intent bypasses despite expanding denylist patterns.

**How to apply:** Classify and reject unsafe or unknown clauses before consulting facts. Normalize only narrowly enumerated benign typos before typed intent matching and grounding; never use fuzzy similarity over arbitrary words. Keep specific values typed where possible, keep broad knowledge out of intent authorization, and constrain any model output to validated references back to approved facts rather than customer-facing prose.