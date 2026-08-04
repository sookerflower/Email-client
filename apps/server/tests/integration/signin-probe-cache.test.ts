/**
 * Regression test for the sign-in-probe driver-cache poisoning.
 *
 * The bug: the worker's driver cache is keyed by account+decrypted-password,
 * and a cache hit returned the entry with whatever auth its CREATOR sent.
 * The sign-in probe (verifyImapCredentials) authenticates before the
 * connection row exists, so its auth has NO connectionId — and when the
 * cache was cold for the account (every first-ever login; any login after
 * a 5-min idle eviction), the probe became the creator. Every later `q`
 * search for that account then threw 'connectionId required for search
 * cache isolation', and background syncs kept resetting the idle timer so
 * it never healed short of a worker restart.
 *
 * This test drives the REAL worker core over its /rpc surface: a
 * connectionId-less testConnection (the probe) against a cold cache,
 * followed by a q-search list call that DOES carry a connectionId. Against
 * the pre-fix code the list call returns the isolation error; the fix
 * re-stamps the requesting call's auth onto the cached driver on every hit.
 *
 * Requires GreenMail (`greenmail-test` container, IMAP 3143, auth-disabled)
 * + the local compose datastores; skips if GreenMail is unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createConnection as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';

const GREENMAIL = { host: '127.0.0.1', imapPort: 3143, smtpPort: 3025 };

const greenmailUp = () =>
  new Promise<boolean>((resolve) => {
    const sock = netConnect({ host: GREENMAIL.host, port: GREENMAIL.imapPort, timeout: 3000 });
    sock.on('connect', () => (sock.destroy(), resolve(true)));
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => (sock.destroy(), resolve(false)));
  });

const up = await greenmailUp();

// Imports after the probe so a docker-less environment skips cleanly.
const { startMailWorker } = await import('../../src/worker/core');
const { env } = await import('../../src/env');

const runId = crypto.randomUUID().slice(0, 8);
const address = `probe-cache-${runId}@classroom.test`;
const SECRET = `itest-secret-${runId}`;

// Plaintext password: driverFor accepts imap.password directly, so this test
// needs no encryption key material of its own.
const imap = {
  imapHost: GREENMAIL.host,
  imapPort: GREENMAIL.imapPort,
  imapSecure: false,
  smtpHost: GREENMAIL.host,
  smtpPort: GREENMAIL.smtpPort,
  smtpSecure: false,
  username: address,
  password: 'probe-secret',
  allowInsecureTls: false,
};

describe.skipIf(!up)('sign-in probe must not poison the driver cache', () => {
  let worker: ReturnType<typeof startMailWorker>;
  let base = '';

  beforeAll(async () => {
    worker = startMailWorker({
      port: 0, // ephemeral
      host: '127.0.0.1',
      secret: SECRET,
      encryptionKey: 'itest-unused-key',
      databaseUrl: env.DATABASE_URL,
      notifyUrl: 'http://127.0.0.1:1/unused',
      pollSeconds: 3600,
      watchersEnabled: () => false,
    });
    await new Promise<void>((resolve) => worker.server.once('listening', resolve));
    base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await worker.close();
  });

  const rpc = async (method: string, args: unknown[], auth: Record<string, unknown>) => {
    const res = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-imap-sidecar-secret': SECRET },
      body: JSON.stringify({ method, args, auth }),
    });
    return (await res.json()) as { result?: unknown; error?: string };
  };

  it('cold cache -> probe -> q search succeeds', async () => {
    // 1. The sign-in probe: connectionId-less auth against a COLD cache for
    //    this (brand-new) account. Pre-fix, this stamps the cached driver
    //    with the probe's identity-free auth.
    const probe = await rpc('testConnection', [], {
      userId: 'sign-in-probe',
      accessToken: '',
      refreshToken: '',
      email: address,
      imap,
    });
    expect(probe.error, 'probe should reach GreenMail').toBeUndefined();
    expect((probe.result as { connected: boolean }).connected).toBe(true);

    // 2. A q search as the engine would issue it, WITH a connectionId. The
    //    cache hit must serve THIS caller's identity: pre-fix it returns
    //    'connectionId required for search cache isolation'.
    const list = await rpc(
      'list',
      [{ folder: 'inbox', query: 'is:unread', maxResults: 5 }],
      {
        userId: `itest-user-${runId}`,
        accessToken: '',
        refreshToken: '',
        email: address,
        connectionId: `itest-conn-${runId}`,
        imap,
      },
    );
    expect(list.error, 'q search after the probe must not throw').toBeUndefined();
    expect(list.result).toBeTruthy();
    expect(Array.isArray((list.result as { threads: unknown[] }).threads)).toBe(true);
  });
});
