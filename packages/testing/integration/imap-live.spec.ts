/**
 * Live smoke test for ImapSmtpMailManager against a real IMAP/SMTP account,
 * run under plain Node (the planned self-host runtime).
 *
 * Requires TEST_IMAP_USER / TEST_IMAP_PASSWORD in the repo root .env;
 * the whole suite is skipped when they are absent.
 *
 *   pnpm --filter @zero/testing exec vitest run --config vitest.integration.config.ts
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv({ path: resolve(__dirname, '../../../.env') });

const user = process.env.TEST_IMAP_USER;
const password = process.env.TEST_IMAP_PASSWORD;

const describeLive = user && password ? describe : describe.skip;

describeLive('ImapSmtpMailManager live smoke test', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let driver: any;
  let firstThreadId: string | undefined;

  beforeAll(async () => {
    const { ImapSmtpMailManager } = await import(
      '../../../apps/server/src/lib/driver/imap'
    );
    driver = new ImapSmtpMailManager({
      auth: {
        userId: 'imap-live-test',
        accessToken: '',
        refreshToken: '',
        email: user!,
        // NOTE: the provider sheet lists imap./smtp.mailsend1.in:465, but those
        // hostnames have no public DNS records and 465 is closed on the actual
        // server. res72238.m.re.cx (= 207.58.172.238, also an A record of
        // mailsend1.in) answers on 993/587.
        imap: {
          imapHost: 'res72238.m.re.cx',
          imapPort: 993,
          imapSecure: true,
          smtpHost: 'res72238.m.re.cx',
          smtpPort: 587,
          smtpSecure: false, // 587 = STARTTLS
          username: user!,
          password: password!,
          // Server presents a self-signed cert (IMAP) / incomplete chain (SMTP).
          allowInsecureTls: true,
        },
      },
    });
  });

  afterAll(async () => {
    await driver?.dispose();
  });

  it('discovers folders and reports counts (count)', async () => {
    const counts = await driver.count();
    console.log('[live] count():', JSON.stringify(counts));
    expect(Array.isArray(counts)).toBe(true);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.map((c: { label?: string }) => c.label)).toContain('inbox');
  });

  it('lists inbox threads (list)', async () => {
    const result = await driver.list({ folder: 'inbox', maxResults: 5 });
    console.log(
      '[live] list(): threads =',
      result.threads.length,
      'nextPageToken =',
      result.nextPageToken,
    );
    expect(Array.isArray(result.threads)).toBe(true);
    if (result.threads.length > 0) {
      firstThreadId = result.threads[0].id;
      expect(typeof firstThreadId).toBe('string');
      expect(result.threads[0].historyId).toBeNull();
    }
  });

  it('fetches a full thread (get)', async () => {
    if (!firstThreadId) {
      console.log('[live] get(): inbox empty, skipping');
      return;
    }
    const thread = await driver.get(firstThreadId);
    console.log(
      '[live] get():',
      JSON.stringify({
        messages: thread.messages.length,
        totalReplies: thread.totalReplies,
        hasUnread: thread.hasUnread,
        subject: thread.latest?.subject,
        from: thread.latest?.sender,
        attachments: thread.latest?.attachments?.length,
      }),
    );
    expect(thread.messages.length).toBeGreaterThan(0);
    expect(thread.latest).toBeDefined();
    expect(thread.latest.threadId).toBe(firstThreadId);
    expect(typeof thread.latest.decodedBody).toBe('string');
  });

  it('sends a test email to itself (create)', async () => {
    const subject = `Zero IMAP driver live test ${new Date().toISOString()}`;
    const result = await driver.create({
      to: [{ email: user! }],
      subject,
      message: '<p>Sent by ImapSmtpMailManager during the step (c) live smoke test.</p>',
      attachments: [],
      headers: {},
    });
    console.log('[live] create():', JSON.stringify(result));
    expect(result.id).toBeTruthy();
  });
});
