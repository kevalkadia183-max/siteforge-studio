// Compatibility re-export wrapper — generator implementation now lives in @workspace/siteforge-core.
// This file keeps existing Studio imports working without modification.
export type { GeneratedSite } from '@workspace/siteforge-core';
export {
  generateSite,
  isAllowedHostedApiUrl,
  hasAbsoluteHostedApiUrl,
  normalizeApiUrl,
} from '@workspace/siteforge-core';
