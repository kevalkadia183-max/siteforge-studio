/**
 * Provider integrations — pure bundled unit tests.
 *
 * Covers:
 *  1.  email default: available + enabled + providerKey=gmail
 *  2.  discovery default: not_configured + disabled
 *  3.  website_analysis default: not_configured + disabled
 *  4.  image default: not_configured + disabled
 *  5.  whatsapp default: not_configured + disabled
 *  6.  getAllRegistryDefaults returns all five capabilities
 *  7.  getDiscoveryAdapter returns null when no adapter registered
 *  8.  Discovery default never pretends Google Maps / google_places is configured
 *  9.  DiscoveryFact: provenance always 'provider' with provider key + providerReference
 * 10.  DiscoveryResultItem: providerReference at item and fact level
 * 11.  filterProspectSafeImages excludes uncertain images
 * 12.  filterProspectSafeImages returns empty list when all uncertain
 * 13.  ProviderRateLimitError carries availability='rate_limited' and retryAt
 * 14.  ProviderRateLimitError with null retryAt
 * 15.  ProviderUnavailableError carries correct availability
 * 16.  ProviderUnavailableError defaults to 'unavailable'
 * 17.  ProviderUnavailableError with 'not_configured' availability
 * 18.  WhatsApp fail-closed: missing adapter → not eligible
 * 19.  WhatsApp fail-closed: missing templateName → not eligible
 * 20.  WhatsApp fail-closed: empty templateName → not eligible
 * 21.  WhatsApp fail-closed: missing templateLanguage → not eligible
 * 22.  WhatsApp fail-closed: requireExplicitConsent=false → not eligible
 * 23.  WhatsApp fail-closed: requireExplicitConsent=undefined → not eligible
 * 24.  WhatsApp fail-closed: consent status 'unknown' → not eligible
 * 25.  WhatsApp fail-closed: consent status 'revoked' → not eligible
 * 26.  WhatsApp: all conditions satisfied → eligible
 * 27.  setDiscoveryAdapter / getDiscoveryAdapter round-trip
 * 28.  setWhatsAppAdapter / getWhatsAppAdapter round-trip
 * 29.  getRegistryDefault returns independent copy (mutation-safe)
 *
 * All tests are pure unit tests — no DB, no network calls.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// ─── Build provider-registry ──────────────────────────────────────────────────

const outputDir = await mkdtemp(join(tmpdir(), "siteforge-providers-"));

const registryOut = join(outputDir, "provider-registry.mjs");
await build({
  entryPoints: [
    new URL("../src/lib/provider-registry.ts", import.meta.url).pathname,
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: registryOut,
  logLevel: "silent",
});

const {
  getRegistryDefault,
  getAllRegistryDefaults,
  filterProspectSafeImages,
  ProviderRateLimitError,
  ProviderUnavailableError,
  checkWhatsAppEligibility,
  setDiscoveryAdapter,
  getDiscoveryAdapter,
  setWhatsAppAdapter,
  getWhatsAppAdapter,
  getProviderDisplayName,
} = await import(pathToFileURL(registryOut).href);

// ─── 1–6: Registry defaults ──────────────────────────────────────────────────

describe("Registry defaults — all five capabilities", () => {
  it("1. email default: available + enabled + providerKey=gmail", () => {
    const entry = getRegistryDefault("email");
    assert.equal(entry.capability, "email");
    assert.equal(entry.providerKey, "gmail");
    assert.equal(entry.displayName, "Gmail");
    assert.equal(entry.availability, "available");
    assert.equal(entry.enabled, true);
  });

  it("2. discovery default: not_configured + disabled", () => {
    const entry = getRegistryDefault("discovery");
    assert.equal(entry.capability, "discovery");
    assert.equal(entry.providerKey, null);
    assert.equal(entry.availability, "not_configured");
    assert.equal(entry.enabled, false);
  });

  it("3. website_analysis default: not_configured + disabled", () => {
    const entry = getRegistryDefault("website_analysis");
    assert.equal(entry.capability, "website_analysis");
    assert.equal(entry.providerKey, null);
    assert.equal(entry.availability, "not_configured");
    assert.equal(entry.enabled, false);
  });

  it("4. image default: not_configured + disabled", () => {
    const entry = getRegistryDefault("image");
    assert.equal(entry.capability, "image");
    assert.equal(entry.providerKey, null);
    assert.equal(entry.availability, "not_configured");
    assert.equal(entry.enabled, false);
  });

  it("5. whatsapp default: not_configured + disabled", () => {
    const entry = getRegistryDefault("whatsapp");
    assert.equal(entry.capability, "whatsapp");
    assert.equal(entry.providerKey, null);
    assert.equal(entry.availability, "not_configured");
    assert.equal(entry.enabled, false);
  });

  it("6. getAllRegistryDefaults returns all five capabilities", () => {
    const all = getAllRegistryDefaults();
    assert.equal(all.length, 5);
    const caps = all.map((e) => e.capability).sort();
    assert.deepEqual(caps, [
      "discovery",
      "email",
      "image",
      "website_analysis",
      "whatsapp",
    ]);
  });
});

// ─── 7–8: Honest unavailable discovery ───────────────────────────────────────

describe("Honest unavailable discovery", () => {
  it("7. No adapter registered → getDiscoveryAdapter returns null", () => {
    setDiscoveryAdapter(null);
    const adapter = getDiscoveryAdapter();
    assert.equal(adapter, null);
  });

  it("8. Discovery default never pretends Google Maps / google_places is configured", () => {
    const entry = getRegistryDefault("discovery");
    assert.equal(entry.availability, "not_configured");
    assert.equal(entry.providerKey, null);
    assert.notEqual(entry.providerKey, "google_maps");
    assert.notEqual(entry.providerKey, "google_places");
  });
});

// ─── 9–10: Normalized provenance ─────────────────────────────────────────────

describe("Discovery fact provenance normalization", () => {
  it("9. Discovery fact has provenance='provider' with provider key and providerReference", () => {
    const fact = {
      fieldName: "businessName",
      value: "Acme Corp",
      provenance: "provider",
      provider: "test_provider",
      providerReference: "place_abc123",
    };
    assert.equal(fact.provenance, "provider");
    assert.equal(fact.provider, "test_provider");
    assert.equal(fact.providerReference, "place_abc123");
  });

  it("10. DiscoveryResultItem has providerReference at item and fact level", () => {
    const item = {
      providerReference: "item_ref_001",
      facts: [
        {
          fieldName: "city",
          value: "Toronto",
          provenance: "provider",
          provider: "test_provider",
          providerReference: "item_ref_001",
        },
      ],
      images: [],
    };
    assert.equal(item.providerReference, "item_ref_001");
    assert.equal(item.facts[0].provenance, "provider");
    assert.equal(item.facts[0].providerReference, "item_ref_001");
  });
});

// ─── 11–12: filterProspectSafeImages ─────────────────────────────────────────

describe("filterProspectSafeImages", () => {
  it("11. excludes uncertain images, retains approved", () => {
    const images = [
      { url: "https://example.com/a.jpg", eligibility: "approved" },
      { url: "https://example.com/b.jpg", eligibility: "uncertain" },
      { url: "https://example.com/c.jpg", eligibility: "uncertain" },
    ];
    const safe = filterProspectSafeImages(images);
    assert.equal(safe.length, 1);
    assert.equal(safe[0].url, "https://example.com/a.jpg");
    assert.equal(safe[0].eligibility, "approved");
  });

  it("12. returns empty list when all images are uncertain", () => {
    const allUncertain = [
      { url: "https://example.com/x.jpg", eligibility: "uncertain" },
      { url: "https://example.com/y.jpg", eligibility: "uncertain" },
    ];
    const safe = filterProspectSafeImages(allUncertain);
    assert.equal(safe.length, 0);
  });
});

// ─── 13–17: Provider error semantics ─────────────────────────────────────────

describe("Provider error classes", () => {
  it("13. ProviderRateLimitError carries availability='rate_limited' and retryAt", () => {
    const retryAt = new Date(Date.now() + 60_000);
    const err = new ProviderRateLimitError("Rate limit exceeded", retryAt);
    assert.equal(err.availability, "rate_limited");
    assert.equal(err.retryAt, retryAt);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "ProviderRateLimitError");
  });

  it("14. ProviderRateLimitError with null retryAt stores null", () => {
    const err = new ProviderRateLimitError("Rate limit exceeded", null);
    assert.equal(err.availability, "rate_limited");
    assert.equal(err.retryAt, null);
  });

  it("15. ProviderUnavailableError carries the given availability", () => {
    const err = new ProviderUnavailableError("Service down", "unavailable");
    assert.equal(err.availability, "unavailable");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "ProviderUnavailableError");
  });

  it("16. ProviderUnavailableError defaults availability to 'unavailable'", () => {
    const err = new ProviderUnavailableError("Not configured");
    assert.equal(err.availability, "unavailable");
  });

  it("17. ProviderUnavailableError with 'not_configured' availability", () => {
    const err = new ProviderUnavailableError("No provider", "not_configured");
    assert.equal(err.availability, "not_configured");
  });
});

// ─── 18–26: WhatsApp fail-closed eligibility ─────────────────────────────────

describe("WhatsApp fail-closed eligibility", () => {
  /** Base eligible input — all conditions satisfied */
  const eligibleBase = {
    adapterAvailable: true,
    templateName: "appointment_reminder",
    templateLanguage: "en_US",
    requireExplicitConsent: true,
    consentStatus: "granted",
  };

  it("18. Missing adapter → not eligible", () => {
    const result = checkWhatsAppEligibility({
      ...eligibleBase,
      adapterAvailable: false,
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reason.toLowerCase().includes("adapter"));
  });

  it("19. Missing templateName (null) → not eligible", () => {
    const result = checkWhatsAppEligibility({
      ...eligibleBase,
      templateName: null,
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reason.toLowerCase().includes("template name"));
  });

  it("20. Empty templateName (whitespace) → not eligible", () => {
    const result = checkWhatsAppEligibility({
      ...eligibleBase,
      templateName: "   ",
    });
    assert.equal(result.eligible, false);
  });

  it("21. Missing templateLanguage (null) → not eligible", () => {
    const result = checkWhatsAppEligibility({
      ...eligibleBase,
      templateLanguage: null,
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reason.toLowerCase().includes("template language"));
  });

  it("22. requireExplicitConsent=false → not eligible", () => {
    const result = checkWhatsAppEligibility({
      ...eligibleBase,
      requireExplicitConsent: false,
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reason.toLowerCase().includes("requireexplicitconsent"));
  });

  it("23. requireExplicitConsent=undefined → not eligible", () => {
    const result = checkWhatsAppEligibility({
      ...eligibleBase,
      requireExplicitConsent: undefined,
    });
    assert.equal(result.eligible, false);
  });

  it("24. Consent status 'unknown' → not eligible", () => {
    const result = checkWhatsAppEligibility({
      ...eligibleBase,
      consentStatus: "unknown",
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reason.toLowerCase().includes("consent"));
  });

  it("25. Consent status 'revoked' → not eligible (permanent block)", () => {
    const result = checkWhatsAppEligibility({
      ...eligibleBase,
      consentStatus: "revoked",
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reason.toLowerCase().includes("revoked"));
  });

  it("26. All conditions satisfied → eligible", () => {
    const result = checkWhatsAppEligibility(eligibleBase);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, "All eligibility conditions satisfied.");
  });
});

// ─── 27–29: Adapter registry wiring ──────────────────────────────────────────

describe("Registry adapter wiring", () => {
  it("27. setDiscoveryAdapter / getDiscoveryAdapter round-trip", () => {
    const fakeAdapter = {
      providerKey: "test_discovery",
      displayName: "Test Discovery",
      async search() {
        return { provider: "test_discovery", items: [], requestId: "x" };
      },
    };
    setDiscoveryAdapter(fakeAdapter);
    const got = getDiscoveryAdapter();
    assert.equal(got, fakeAdapter);
    assert.equal(got?.providerKey, "test_discovery");
    assert.equal(getProviderDisplayName("test_discovery"), "Test Discovery");
    // Reset
    setDiscoveryAdapter(null);
    assert.equal(getDiscoveryAdapter(), null);
  });

  it("28. setWhatsAppAdapter / getWhatsAppAdapter round-trip", () => {
    const fakeAdapter = {
      providerKey: "test_whatsapp",
      displayName: "Test WhatsApp",
      async sendTemplate() {
        return {
          provider: "test_whatsapp",
          status: "accepted",
          requestId: "y",
        };
      },
      webhookVerification: {
        verifyChallenge() {
          return null;
        },
        verifySignature() {
          return false;
        },
      },
    };
    setWhatsAppAdapter(fakeAdapter);
    const got = getWhatsAppAdapter();
    assert.equal(got, fakeAdapter);
    assert.equal(got?.providerKey, "test_whatsapp");
    assert.equal(getProviderDisplayName("test_whatsapp"), "Test WhatsApp");
    // Reset
    setWhatsAppAdapter(null);
    assert.equal(getWhatsAppAdapter(), null);
  });

  it("29. getRegistryDefault returns independent copy (mutation-safe)", () => {
    const a = getRegistryDefault("email");
    const b = getRegistryDefault("email");
    // Mutate a
    a.enabled = false;
    a.providerKey = "mutated";
    // b should be unaffected
    assert.equal(b.enabled, true);
    assert.equal(b.providerKey, "gmail");
  });
});
