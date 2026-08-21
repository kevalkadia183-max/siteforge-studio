import { createClerkClient } from '@clerk/backend';
import { clerk } from '@clerk/testing/playwright';
import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
} from '@playwright/test';

type WebsiteRecord = {
  id: string;
};

type WebsiteList = {
  websites: WebsiteRecord[];
};

async function deleteWebsites(page: Page): Promise<void> {
  const websites = await page.evaluate(async () => {
    const response = await fetch('/api/websites');
    if (!response.ok) {
      throw new Error(`Could not list websites: HTTP ${response.status}`);
    }
    return ((await response.json()) as WebsiteList).websites;
  });

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

function isEmailDeliveryRequest(request: Request): boolean {
  const url = request.url();
  return (
    url.startsWith('mailto:') ||
    /\/api\/(?:email|emails|mail|messages)(?:[/?#]|$)/i.test(url) ||
    /(?:emailjs|sendgrid|mailgun|postmark|resend)\b/i.test(url)
  );
}

test('keeps generated contact submissions safe in the Studio preview', async ({
  browser,
}) => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error('CLERK_SECRET_KEY is required for authenticated browser tests.');
  }

  const clerkClient = createClerkClient({ secretKey });
  const runId = randomUUID().replaceAll('-', '').slice(0, 20);
  const emailAddress = `siteforge-contact-preview-${runId}@example.com`;
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
    const mailtoNavigations: string[] = [];
    const emailDeliveryRequests: string[] = [];

    page.on('framenavigated', (frame) => {
      if (frame.url().startsWith('mailto:')) {
        mailtoNavigations.push(frame.url());
      }
    });
    page.on('request', (request) => {
      if (isEmailDeliveryRequest(request)) {
        emailDeliveryRequests.push(request.url());
      }
    });

    await page.goto('/');
    await clerk.signIn({ page, emailAddress });
    await page.goto('/studio');
    await expect(page.getByTestId('save-status')).toContainText('Saved');

    const preview = page.getByTestId('preview-iframe');
    await expect(preview).toHaveAttribute('sandbox', 'allow-scripts');
    await page.getByTestId('select-page').selectOption('contact');

    const contactForm = page
      .frameLocator('[data-testid="preview-iframe"]')
      .locator('.contact-form');
    const nameInput = contactForm.getByLabel('Name');
    const emailInput = contactForm.getByLabel('Email');
    const messageInput = contactForm.getByLabel('Message');
    const confirmation = contactForm.locator('.form-status');

    await expect(contactForm).toBeVisible();

    await nameInput.fill('Preview Click Sender');
    await emailInput.fill('click.sender@example.com');
    await messageInput.fill('Testing the click submission path.');
    await contactForm.getByRole('button', { name: 'Send Message' }).click();

    await expect(confirmation).toHaveText(
      'Thanks! This is a secure preview, so your message was not sent.',
    );
    await expect(nameInput).toHaveValue('');
    await expect(emailInput).toHaveValue('');
    await expect(messageInput).toHaveValue('');

    await nameInput.fill('Preview Enter Sender');
    await emailInput.fill('enter.sender@example.com');
    await messageInput.fill('Testing the Enter-key submission path.');
    await emailInput.press('Enter');

    await expect(confirmation).toHaveText(
      'Thanks! This is a secure preview, so your message was not sent.',
    );
    await expect(nameInput).toHaveValue('');
    await expect(emailInput).toHaveValue('');
    await expect(messageInput).toHaveValue('');
    expect(mailtoNavigations).toEqual([]);
    expect(emailDeliveryRequests).toEqual([]);

    testFailed = false;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (page && !page.isClosed()) {
      await deleteWebsites(page).catch((error: unknown) => {
        cleanupErrors.push(error);
      });
    }
    await context?.close().catch((error: unknown) => {
      cleanupErrors.push(error);
    });
    await clerkClient.users.deleteUser(user.id).catch((error: unknown) => {
      cleanupErrors.push(error);
    });

    if (!testFailed && cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'E2E test cleanup failed.');
    }
  }
});