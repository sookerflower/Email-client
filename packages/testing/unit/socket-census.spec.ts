import { describe, expect, it } from 'vitest';
import {
  createSocketCensus,
  IMAP_CEILING,
} from '../../apps/server/src/worker/socket-census';

const ACCOUNT = 'user@imap.example';

describe('socket census (Phase 6.3)', () => {
  it('tracks per-kind open counts and cumulative opens', () => {
    const census = createSocketCensus();
    const closeDriver = census.open(ACCOUNT, 'driver');
    const closeWatcher = census.open(ACCOUNT, 'watcher');
    census.open(ACCOUNT, 'smtp')();

    let stats = census.snapshot().accounts[ACCOUNT]!;
    expect(stats.open).toEqual({ driver: 1, watcher: 1, smtp: 0 });
    expect(stats.opens).toEqual({ driver: 1, watcher: 1, smtp: 1 });

    closeDriver();
    closeWatcher();
    stats = census.snapshot().accounts[ACCOUNT]!;
    expect(stats.open).toEqual({ driver: 0, watcher: 0, smtp: 0 });
  });

  it('records the max concurrent IMAP count; SMTP does not count toward it', () => {
    const census = createSocketCensus();
    const a = census.open(ACCOUNT, 'driver');
    const b = census.open(ACCOUNT, 'watcher');
    census.open(ACCOUNT, 'smtp'); // deliberately left open
    a();
    b();
    const stats = census.snapshot().accounts[ACCOUNT]!;
    expect(stats.maxImap).toBe(2);
    expect(stats.maxImap).toBeLessThanOrEqual(IMAP_CEILING);
    expect(stats.maxImapAt).not.toBeNull();
  });

  it('releasers are idempotent (close event + failure path may both fire)', () => {
    const census = createSocketCensus();
    const release = census.open(ACCOUNT, 'driver');
    release();
    release();
    release();
    const stats = census.snapshot().accounts[ACCOUNT]!;
    expect(stats.open.driver).toBe(0);
    expect(stats.opens.driver).toBe(1);
  });

  it('keeps accounts independent and reports events with running imapOpen', () => {
    const census = createSocketCensus();
    const other = 'other@imap.example';
    census.open(ACCOUNT, 'driver');
    census.open(other, 'watcher');
    const snap = census.snapshot();
    expect(snap.accounts[ACCOUNT]!.open.driver).toBe(1);
    expect(snap.accounts[other]!.open.watcher).toBe(1);
    expect(snap.accounts[other]!.open.driver).toBe(0);
    const last = snap.events.at(-1)!;
    expect(last.account).toBe(other);
    expect(last.imapOpen).toBe(1);
  });
});
