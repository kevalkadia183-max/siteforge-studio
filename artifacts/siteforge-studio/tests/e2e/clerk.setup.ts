import { test as setup } from '@playwright/test';
import { clerkSetup } from '@clerk/testing/playwright';

setup('prepare Clerk test mode', async () => {
  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:80';
  const healthResponse = await fetch(new URL('/api/healthz', baseURL));
  if (!healthResponse.ok) {
    throw new Error(
      `SiteForge API is unavailable at ${baseURL}. Start the API Server and SiteForge Studio workflows, or set E2E_BASE_URL to their shared preview URL.`,
    );
  }

  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error('CLERK_SECRET_KEY is required for authenticated browser tests.');
  }

  process.env.CLERK_PUBLISHABLE_KEY ??= process.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    throw new Error(
      'CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY is required for authenticated browser tests.',
    );
  }

  await clerkSetup();
});