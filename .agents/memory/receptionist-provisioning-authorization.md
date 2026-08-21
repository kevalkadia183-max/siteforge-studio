---
name: Receptionist provisioning authorization
description: The durable authorization boundary for creating SiteForge receptionists after the Clerk account migration.
---

Signed-in SiteForge owners should provision owner-scoped receptionists through their verified Clerk session. The global pilot setup key remains only as a compatibility path for anonymous legacy/API provisioning.

**Why:** Keeping the pre-account global secret gate in the signed-in Studio caused valid owners to receive persistent 401 errors and conflicted with the account ownership model.

**How to apply:** Derive owner identity from verified Clerk auth, keep signed-in receptionists out of the global pilot slot, and never reintroduce the pilot-key field into the authenticated Studio. Anonymous provisioning must still fail closed without the legacy key.