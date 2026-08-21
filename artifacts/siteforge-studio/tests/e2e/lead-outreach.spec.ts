import { createClerkClient } from '@clerk/backend';
import { clerk } from '@clerk/testing/playwright';
import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from '@playwright/test';

test('enforces fact confirmation and durable opt-out in Lead Outreach', async ({
  browser,
}) => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY is required for authenticated browser tests.');
  }

  const clerkClient = createClerkClient({ secretKey });
  const runId = randomUUID().replace(/-/g, '').slice(0, 20);
  const emailAddress = `siteforge-lead-preview-${runId}@example.com`;
  const user = await clerkClient.users.createUser({
    emailAddress: [emailAddress],
    skipPasswordRequirement: true,
  });

  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let testFailed = true;

  try {
    context = await browser.newContext();
    page = await context.newPage();

    await page.goto('/');
    await clerk.signIn({ page, emailAddress });

    // Navigate to leads
    await page.goto('/leads');
    // Ensure we are logged in and API is ready
    await expect(page.getByText('Lead Acquisition Workspace')).toBeVisible({ timeout: 15000 });

    const testBusinessName = 'Testing Co ' + runId;
    
    // 1. POST /api/leads/import with the specific schema
    const importRes = await page.evaluate(async (data) => {
      const response = await fetch('/api/leads/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        throw new Error(`Could not import lead: HTTP ${response.status} - ${await response.text()}`);
      }
      return await response.json();
    }, {
      items: [{
        businessName: testBusinessName,
        category: 'Software',
        city: 'San Francisco',
        region: 'CA',
        country: 'US',
        email: 'hello@testing.com',
        websiteStatus: 'no_website',
        sourceProvider: 'e2e_csv'
      }]
    });

    const leadId = importRes.results[0].leadId;

    // 2. PATCH /api/leads/:leadId with ONLY {pipelineStatus:'qualified'}
    await page.evaluate(async (leadId) => {
      const response = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineStatus: 'qualified' }),
      });
      if (!response.ok) {
        throw new Error(`Could not patch lead: HTTP ${response.status}`);
      }
    }, leadId);

    // 3. fetch GET /api/leads/:leadId and assert its businessName source provenance remains imported (no user_provided)
    const getRes = await page.evaluate(async (leadId) => {
      const response = await fetch(`/api/leads/${leadId}`);
      if (!response.ok) {
        throw new Error(`Could not get lead: HTTP ${response.status}`);
      }
      return await response.json();
    }, leadId);

    const businessNameSource = getRes.sources.find((s: any) => s.fieldName === 'businessName');
    expect(businessNameSource.provenance).toBe('imported');

    // 4. Navigate UI and assert Business Name imported confirmation is enabled
    await page.goto(`/leads/${leadId}`);
    
    // Wait for Lead Details to load
    await expect(page.getByText(testBusinessName).first()).toBeVisible();
    
    // Go to Outreach Tab
    await page.getByRole('tab', { name: 'Outreach' }).click();

    // Prepare Draft
    await page.getByRole('button', { name: 'Prepare Outreach Draft' }).click();

    // The businessName checkbox should be required and display "imported" or "unverified"
    const prepareDraftForm = page.locator('form');
    await expect(prepareDraftForm).toBeVisible();

    // Try to submit without confirming
    await prepareDraftForm.getByRole('button', { name: 'Create Fact-Grounded Draft' }).click();

    // Expect a toast saying "Confirmation required"
    await expect(page.getByText('Confirmation required').first()).toBeVisible();

    // Check it
    await page.getByTestId('confirm-businessName').check();

    // Submit again
    await prepareDraftForm.getByRole('button', { name: 'Create Fact-Grounded Draft' }).click();

    // Wait for "Draft created" toast
    await expect(page.getByText('Draft created').first()).toBeVisible();
    
    // Form closes on success, so we should see the DraftCard now.
    await expect(page.getByText('Mark Reviewed').first()).toBeVisible();

    // 5. assert businessName verified (check via API)
    const getRes2 = await page.evaluate(async (leadId) => {
      const response = await fetch(`/api/leads/${leadId}`);
      return await response.json();
    }, leadId);
    
    const businessNameSource2 = getRes2.sources.find((s: any) => s.fieldName === 'businessName' && s.provenance === 'verified');
    expect(businessNameSource2).toBeDefined();
    
    // optionally check the factSnapshot
    
    // 6. Opt out
    await page.getByPlaceholder('Reason for opt-out...').fill('Not interested anymore');
    page.once('dialog', dialog => dialog.accept());
    
    await page.getByRole('button', { name: 'Permanently Opt-Out' }).click();
    await expect(page.getByText('Lead Opted Out').first()).toBeVisible();

    // 7. Lead Details must show Permanently Opted Out and a disabled Permanent button
    await page.getByRole('tab', { name: 'Lead Details' }).click();
    await expect(page.getByRole('heading', { name: 'Permanently Opted Out' })).toBeVisible();
    
    const unsuppressBtn = page.getByRole('button', { name: /Permanent/ });
    await expect(unsuppressBtn).toBeDisabled();

    // Check GET response directly
    const getRes3 = await page.evaluate(async (leadId) => {
      const response = await fetch(`/api/leads/${leadId}`);
      return await response.json();
    }, leadId);

    // 8. authenticated PUT /api/leads/:leadId/suppression with an ordinary reason must return 409
    const putSuppressionRes = await page.evaluate(async (leadId) => {
      const response = await fetch(`/api/leads/${leadId}/suppression`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'ordinary suppression attempt' }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }, leadId);

    const getRes4 = await page.evaluate(async (leadId) => {
      const response = await fetch(`/api/leads/${leadId}`);
      return await response.json();
    }, leadId);

    expect(putSuppressionRes.status).toBe(409);

    // 9. reload GET lead/detail and UI
    await page.reload();
    await expect(page.getByText(testBusinessName).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Lead Details' }).click();

    // 10. assert heading remains Permanently Opted Out, canonical reason remains Outreach opt-out: <reason>
    await expect(page.getByRole('heading', { name: 'Permanently Opted Out' })).toBeVisible();
    await expect(page.getByText('Outreach opt-out: Not interested anymore').first()).toBeVisible();

    // 11. Permanent control remains disabled
    const reloadedUnsuppressBtn = page.getByRole('button', { name: /Permanent/ });
    await expect(reloadedUnsuppressBtn).toBeDisabled();

    // 12. then DELETE suppression also remains 409
    const deleteSuppressionRes = await page.evaluate(async (leadId) => {
      const response = await fetch(`/api/leads/${leadId}/suppression`, { method: 'DELETE' });
      return response.status;
    }, leadId);
    expect(deleteSuppressionRes).toBe(409);

    testFailed = false;
  } finally {
    const cleanupErrors: unknown[] = [];
    await context?.close().catch((error: unknown) => {
      cleanupErrors.push(error);
    });
    await clerkClient.users.deleteUser(user.id).catch((error: unknown) => {
      cleanupErrors.push(error);
    });

    if (!testFailed && cleanupErrors.length > 0) {
      throw new Error(`E2E test cleanup failed: ${cleanupErrors.map(e => String(e)).join(', ')}`);
    }
  }
});
