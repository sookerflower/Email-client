/**
 * Per-account socket census (Phase 6.3 of MIGRATION-PLAN.md).
 *
 * Counts every live mail-server socket the worker holds, per account:
 * driver-cache IMAP connections, IDLE watcher connections, and transient
 * SMTP connections. The point is the fail2ban invariant — never more than
 * IMAP_CEILING concurrent IMAP sockets per account — recorded as a running
 * per-account maximum the E2E suites ASSERT on, instead of a log to eyeball.
 *
 * A socket is counted from the moment the connection ATTEMPT starts (a
 * failed login attempt is exactly what fail2ban counts) until the releaser
 * runs. Releasers are idempotent: connect-failure paths and 'close' events
 * may both fire for the same socket.
 */

export type SocketKind = 'driver' | 'watcher' | 'smtp';

/** Design ceiling: one cached driver connection + one IDLE watcher. */
export const IMAP_CEILING = 2;

const EVENT_LIMIT = 300;

interface AccountStats {
  /** Currently-open sockets by kind. */
  open: Record<SocketKind, number>;
  /** Cumulative opens by kind (the login-churn leg asserts on deltas). */
  opens: Record<SocketKind, number>;
  /** Highest concurrent IMAP (driver + watcher) count ever observed. */
  maxImap: number;
  maxImapAt: number | null;
}

export interface CensusEvent {
  at: number;
  account: string;
  kind: SocketKind;
  delta: 1 | -1;
  /** IMAP sockets (driver + watcher) open for the account AFTER this event. */
  imapOpen: number;
}

export interface CensusSnapshot {
  imapCeiling: number;
  accounts: Record<string, AccountStats>;
  events: CensusEvent[];
}

export interface SocketCensus {
  /** Register a socket attempt; returns an idempotent releaser. */
  open(account: string, kind: SocketKind): () => void;
  snapshot(): CensusSnapshot;
}

const zero = (): Record<SocketKind, number> => ({ driver: 0, watcher: 0, smtp: 0 });

export function createSocketCensus(): SocketCensus {
  const accounts = new Map<string, AccountStats>();
  const events: CensusEvent[] = [];

  const statsFor = (account: string): AccountStats => {
    let stats = accounts.get(account);
    if (!stats) {
      stats = { open: zero(), opens: zero(), maxImap: 0, maxImapAt: null };
      accounts.set(account, stats);
    }
    return stats;
  };

  const record = (account: string, kind: SocketKind, delta: 1 | -1): void => {
    const stats = statsFor(account);
    stats.open[kind] += delta;
    if (delta === 1) stats.opens[kind] += 1;
    const imapOpen = stats.open.driver + stats.open.watcher;
    if (kind !== 'smtp' && imapOpen > stats.maxImap) {
      stats.maxImap = imapOpen;
      stats.maxImapAt = Date.now();
      if (imapOpen > IMAP_CEILING) {
        console.warn(
          `[census] ${account}: ${imapOpen} concurrent IMAP sockets (driver=${stats.open.driver} watcher=${stats.open.watcher}) exceeds ceiling ${IMAP_CEILING}`,
        );
      }
    }
    events.push({ at: Date.now(), account, kind, delta, imapOpen });
    if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
  };

  return {
    open(account, kind) {
      record(account, kind, 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        record(account, kind, -1);
      };
    },
    snapshot() {
      return {
        imapCeiling: IMAP_CEILING,
        accounts: Object.fromEntries(
          [...accounts.entries()].map(([account, stats]) => [
            account,
            { ...stats, open: { ...stats.open }, opens: { ...stats.opens } },
          ]),
        ),
        events: [...events],
      };
    },
  };
}
