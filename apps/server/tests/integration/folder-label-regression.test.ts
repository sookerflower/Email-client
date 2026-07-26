/**
 * Regression test for the folder-label bug fixed in Phase 3.1
 * (MIGRATION-PLAN.md progress log).
 *
 * The bug: sync stored only per-message tags (UNREAD/STARRED/keywords) and
 * never folder membership, so IMAP threads landed in the index without an
 * INBOX label and index-backed folder listing could never match them. Thread
 * COUNTS looked right the whole time — only label membership was wrong —
 * so this test asserts label rows directly. Against the pre-3.1 code
 * (syncThread({threadId}) with tags-only labels) the INBOX assertion below
 * fails; that is the point.
 *
 * Requires: local Postgres (docker compose) + GreenMail (`greenmail-test`
 * container, IMAP 3143 / SMTP 3025, auth-disabled). Skips if GreenMail is
 * unreachable so CI without docker stays green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createConnection as netConnect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { eq, and } from 'drizzle-orm';

const GREENMAIL = { host: '127.0.0.1', imapPort: 3143, smtpPort: 3025 };

const greenmailUp = () =>
  new Promise<boolean>((resolve) => {
    const sock = netConnect({ host: GREENMAIL.host, port: GREENMAIL.imapPort, timeout: 3000 });
    sock.on('connect', () => (sock.destroy(), resolve(true)));
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => (sock.destroy(), resolve(false)));
  });

// Blob writes go to a throwaway dir, not the repo's ./data. Must be set
// before the engine modules load.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'zero-test-blobs-'));

const up = await greenmailUp();

// Imports after env/DATA_DIR setup; these pull the cf-shim env chain.
const { createDb } = await import('../../src/db');
const { user, connection, thread, threadLabel } = await import('../../src/db/schema');
const { MailEngine } = await import('../../src/lib/mail-engine');
const { ImapSmtpMailManager } = await import('../../src/lib/driver/imap');
const { env } = await import('../../src/env');

const db = createDb(env.DATABASE_URL).db;

const runId = crypto.randomUUID().slice(0, 8);
const address = `regress-${runId}@classroom.test`;
const password = 'regress-secret';
const userId = `test-user-${runId}`;
const connectionId = crypto.randomUUID();
const subject = `folder-label regression ${runId}`;

describe.skipIf(!up)('folder-label regression (Phase 3.1)', () => {
  beforeAll(async () => {
    const now = new Date();
    await db.insert(user).values({
      id: userId,
      name: 'Regression Test',
      email: address,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(connection).values({
      id: connectionId,
      userId,
      email: address,
      providerId: 'imap',
      imapHost: GREENMAIL.host,
      imapPort: GREENMAIL.imapPort,
      imapSecure: false,
      smtpHost: GREENMAIL.host,
      smtpPort: GREENMAIL.smtpPort,
      smtpSecure: false,
      username: address,
      passwordEncrypted: 'unused-direct-driver',
      scope: '',
      expiresAt: new Date(now.getTime() + 365 * 24 * 3600 * 1000),
      createdAt: now,
      updatedAt: now,
    });

    // Deliver a message into the (auto-created) GreenMail mailbox via SMTP.
    const transporter = nodemailer.createTransport({
      host: GREENMAIL.host,
      port: GREENMAIL.smtpPort,
      secure: false,
    });
    await transporter.sendMail({
      from: `sender-${runId}@classroom.test`,
      to: address,
      subject,
      html: '<p>regression payload</p>',
    });
    transporter.close();
    // GreenMail delivery is synchronous-ish; small settle window.
    await new Promise((r) => setTimeout(r, 1500));
  });

  afterAll(async () => {
    // Index rows cascade off the connection delete.
    await db.delete(connection).where(eq(connection.id, connectionId));
    await db.delete(user).where(eq(user.id, userId));
  });

  it('syncFolderOnce attaches the folder label, not just tags', async () => {
    const row = await db.query.connection.findFirst({
      where: (f, { eq: e }) => e(f.id, connectionId),
    });
    expect(row).toBeTruthy();

    // Direct driver (plaintext password), bypassing the sidecar hop — this
    // test targets engine logic, not transport.
    const driver = new ImapSmtpMailManager({
      auth: {
        userId,
        accessToken: '',
        refreshToken: '',
        email: address,
        connectionId,
        imap: {
          imapHost: GREENMAIL.host,
          imapPort: GREENMAIL.imapPort,
          imapSecure: false,
          smtpHost: GREENMAIL.host,
          smtpPort: GREENMAIL.smtpPort,
          smtpSecure: false,
          username: address,
          password,
          allowInsecureTls: false,
        },
      },
    });

    try {
      const engine = MailEngine.createWithDriver(connectionId, row!, driver);
      const result = await engine.syncFolderOnce('inbox');

      // Sanity: the sync did index our message (count alone is NOT the
      // regression assertion — counts passed even when the bug was live).
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.synced).toBeGreaterThanOrEqual(1);

      const threads = await db.query.thread.findMany({
        where: eq(thread.connectionId, connectionId),
      });
      expect(threads.length).toBeGreaterThanOrEqual(1);
      const ourThread = threads.find((t) => t.latestSubject === subject);
      expect(ourThread, `synced thread with subject "${subject}"`).toBeTruthy();

      // THE regression assertion: folder membership must be recorded as a
      // label. Pre-3.1 code stored tags only -> no INBOX row -> this fails.
      const labels = await db.query.threadLabel.findMany({
        where: and(
          eq(threadLabel.connectionId, connectionId),
          eq(threadLabel.threadId, ourThread!.threadId),
        ),
      });
      const labelIds = labels.map((l) => l.labelId);
      expect(labelIds).toContain('INBOX');

      // Tag labels still present alongside the folder label (fresh SMTP
      // delivery is unseen -> UNREAD).
      expect(labelIds).toContain('UNREAD');
    } finally {
      await driver.dispose().catch(() => undefined);
    }
  });
});
