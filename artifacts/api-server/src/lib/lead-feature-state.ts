/**
 * Lead Acquisition feature state helpers.
 *
 * LEAD_ACQUISITION_ENABLED env var controls whether the module is available.
 * Default: enabled (true) unless explicitly set to "false".
 *
 * Module enablement is synchronous and env-based only.
 * Discovery provider configuration is NOT claimed from env —
 * it requires owner-aware provider settings (see provider-registry.ts and
 * provider-operations.ts). The /lead-acquisition/config endpoint returns
 * configured=false for now to reflect honest state.
 */

export interface LeadAcquisitionConfig {
  enabled: boolean;
  discoveryProvider: {
    configured: boolean;
    message?: string | null;
  };
}

/**
 * Returns whether the lead acquisition feature module is enabled.
 * Synchronous — checks env var only.
 * Enabled by default unless LEAD_ACQUISITION_ENABLED=false.
 */
export function isLeadAcquisitionEnabled(): boolean {
  const val = process.env["LEAD_ACQUISITION_ENABLED"];
  if (val === undefined || val === null) return true;
  return val.trim().toLowerCase() !== "false";
}

/**
 * Returns the discovery provider state for the non-owner-aware config endpoint.
 *
 * Always returns configured=false because:
 *  - Discovery configuration is owner-scoped (per provider-operations.ts).
 *  - The /lead-acquisition/config endpoint is not owner-aware.
 *  - Do NOT claim discovery is configured from env vars.
 *
 * Owner-aware discovery state is available via GET /provider-settings.
 */
export function getDiscoveryProviderState(): {
  configured: boolean;
  message: string | null;
} {
  return {
    configured: false,
    message: "Provider not configured",
  };
}

/**
 * Returns the full lead acquisition config for the /lead-acquisition/config endpoint.
 * Module enablement is synchronous. Discovery provider is always not-configured
 * at this level — see GET /provider-settings for owner-aware state.
 */
export function getLeadAcquisitionConfig(): LeadAcquisitionConfig {
  return {
    enabled: isLeadAcquisitionEnabled(),
    discoveryProvider: getDiscoveryProviderState(),
  };
}
