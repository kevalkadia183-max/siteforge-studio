import { createClerkClient } from '@clerk/backend';
import { clerk } from '@clerk/testing/playwright';
import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

type WebsiteRecord = {
  id: string;
  name: string;
  revision: number;
  projectSource: {
    id?: string;
    name?: string;
    business?: {
      name?: string;
    };
  };
};

type WebsiteList = {
  websites: WebsiteRecord[];
};

async function signInSession(
  browser: Browser,
  emailAddress: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/');
  await clerk.signIn({ page, emailAddress });
  await page.goto('/studio');
  await expect(page.getByTestId('save-status')).toContainText('Saved');

  return { context, page };
}

async function listWebsites(page: Page): Promise<WebsiteRecord[]> {
  return page.evaluate(async () => {
    const response = await fetch('/api/websites');
    if (!response.ok) {
      throw new Error(`Could not list websites: HTTP ${response.status}`);
    }
    return ((await response.json()) as WebsiteList).websites;
  });
}

async function deleteWebsites(page: Page): Promise<void> {
  const websites = await listWebsites(page);
  await page.evaluate(async (ids) => {
    for (const id of ids) {
      const response = await fetch(`/api/websites/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Could not delete website ${id}: HTTP ${response.status}`);
      }
    }
  }, websites.map((website) => website.id));
}

function waitForWebsiteMutation(
  page: Page,
  websiteId: string,
  method: 'PUT' | 'PATCH' | 'POST',
  status: number,
  suffix = '',
) {
  const expectedPath = `/api/websites/${websiteId}${suffix}`;
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === expectedPath &&
      response.request().method() === method &&
      response.status() === status,
  );
}

async function renameActiveProject(
  page: Page,
  projectId: string,
  currentName: string,
  nextName: string,
): Promise<void> {
  await page.getByTestId('btn-project-menu').click();
  await page.getByTestId(`btn-rename-project-${projectId}`).click();
  const input = page.getByRole('textbox', { name: `Rename ${currentName}` });
  await input.fill(nextName);
  await input.press('Enter');
}

test('protects multi-device saves and keeps duplicate identities distinct', async ({
  browser,
}) => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY is required for authenticated browser tests.');
  }

  const clerkClient = createClerkClient({ secretKey });
  const runId = randomUUID().replaceAll('-', '').slice(0, 20);
  const emailAddress = `siteforge-concurrency-${runId}@example.com`;
  const user = await clerkClient.users.createUser({
    emailAddress: [emailAddress],
    skipPasswordRequirement: true,
  });

  let firstContext: BrowserContext | undefined;
  let secondContext: BrowserContext | undefined;
  let firstPage: Page | undefined;
  let testFailed = true;

  try {
    const firstSession = await signInSession(browser, emailAddress);
    firstContext = firstSession.context;
    firstPage = firstSession.page;

    const initialWebsites = await listWebsites(firstPage);
    expect(initialWebsites).toHaveLength(1);
    const sourceId = initialWebsites[0].id;
    const initialProjectName = initialWebsites[0].name;

    const secondSession = await signInSession(browser, emailAddress);
    secondContext = secondSession.context;
    const secondPage = secondSession.page;

    const serverSavedBusiness = `Server saved ${runId}`;
    const staleBusiness = `Stale draft ${runId}`;
    const latestBusiness = `Latest conflict draft ${runId}`;

    const firstSave = waitForWebsiteMutation(firstPage, sourceId, 'PUT', 200);
    await firstPage.getByTestId('input-biz-name').fill(serverSavedBusiness);
    await firstSave;
    await expect(firstPage.getByTestId('save-status')).toContainText('Saved');

    const staleSave = waitForWebsiteMutation(secondPage, sourceId, 'PUT', 409);
    await secondPage.getByTestId('input-biz-name').fill(staleBusiness);
    await staleSave;
    await expect(secondPage.getByTestId('save-conflict-banner')).toBeVisible();
    await expect(secondPage.getByTestId('save-status')).toContainText('Conflict');

    let source = (await listWebsites(firstPage)).find((website) => website.id === sourceId);
    expect(source?.projectSource.business?.name).toBe(serverSavedBusiness);

    const overwrite = waitForWebsiteMutation(secondPage, sourceId, 'PUT', 200);
    await secondPage.getByTestId('input-biz-name').fill(latestBusiness);
    await secondPage.getByTestId('btn-conflict-overwrite').click();
    const overwriteRecord = (await overwrite).json() as Promise<WebsiteRecord>;
    expect((await overwriteRecord).projectSource.business?.name).toBe(latestBusiness);
    await expect(secondPage.getByTestId('save-status')).toContainText('Saved');
    await expect(secondPage.getByTestId('save-conflict-banner')).toHaveCount(0);

    await firstPage.reload();
    await secondPage.reload();
    await expect(firstPage.getByTestId('input-biz-name')).toHaveValue(latestBusiness);
    await expect(secondPage.getByTestId('input-biz-name')).toHaveValue(latestBusiness);

    const serverRename = `Server rename ${runId}`;
    const staleRename = `Stale rename ${runId}`;
    const freshRename = waitForWebsiteMutation(firstPage, sourceId, 'PATCH', 200);
    await renameActiveProject(firstPage, sourceId, initialProjectName, serverRename);
    await freshRename;
    await expect(firstPage.getByTestId('btn-project-menu')).toContainText(serverRename);
    await firstPage
      .getByRole('dialog', { name: 'Projects' })
      .getByRole('button', { name: 'Close' })
      .click();

    const staleRenameResponse = waitForWebsiteMutation(secondPage, sourceId, 'PATCH', 409);
    await renameActiveProject(secondPage, sourceId, initialProjectName, staleRename);
    await staleRenameResponse;
    await expect(secondPage.getByTestId('mutation-error')).toContainText('Rename conflict');
    await secondPage.getByRole('dialog', { name: 'Projects' }).press('Escape');
    await expect(secondPage.getByTestId('save-conflict-banner')).toBeVisible();
    await expect(secondPage.getByTestId('save-status')).toContainText('Conflict');

    source = (await listWebsites(firstPage)).find((website) => website.id === sourceId);
    expect(source?.name).toBe(serverRename);
    expect(source?.projectSource.name).toBe(serverRename);

    await secondPage.getByTestId('btn-conflict-load-server').click();
    await expect(secondPage.getByTestId('btn-project-menu')).toContainText(serverRename);

    const duplicateResponse = waitForWebsiteMutation(
      firstPage,
      sourceId,
      'POST',
      201,
      '/duplicate',
    );
    await firstPage.getByTestId('btn-project-menu').click();
    await firstPage.getByTestId(`btn-duplicate-project-${sourceId}`).click();
    const createdDuplicate = (await duplicateResponse).json() as Promise<WebsiteRecord>;
    expect((await createdDuplicate).id).not.toBe(sourceId);
    await expect(firstPage.getByTestId('save-status')).toContainText('Saved');

    await firstPage.reload();
    const reloadedWebsites = await listWebsites(firstPage);
    expect(reloadedWebsites).toHaveLength(2);

    const reloadedSource = reloadedWebsites.find((website) => website.id === sourceId);
    const duplicate = reloadedWebsites.find((website) => website.id !== sourceId);
    expect(reloadedSource).toBeDefined();
    expect(duplicate).toBeDefined();
    expect(reloadedSource?.projectSource.id).toBe(reloadedSource?.id);
    expect(duplicate?.projectSource.id).toBe(duplicate?.id);
    expect(duplicate?.projectSource.id).not.toBe(reloadedSource?.projectSource.id);
    expect(duplicate?.name).toBe(`${serverRename} (Copy)`);
    expect(duplicate?.projectSource.name).toBe(`${serverRename} (Copy)`);

    await firstPage.getByTestId('btn-project-menu').click();
    await expect(firstPage.getByTestId(`project-item-${sourceId}`)).toBeVisible();
    await expect(firstPage.getByTestId(`project-item-${duplicate!.id}`)).toBeVisible();
    testFailed = false;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (firstPage && !firstPage.isClosed()) {
      await deleteWebsites(firstPage).catch((error: unknown) => {
        cleanupErrors.push(error);
      });
    }
    for (const context of [secondContext, firstContext]) {
      await context?.close().catch((error: unknown) => {
        cleanupErrors.push(error);
      });
    }
    await clerkClient.users.deleteUser(user.id).catch((error: unknown) => {
      cleanupErrors.push(error);
    });

    if (!testFailed && cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'E2E test cleanup failed.');
    }
  }
});