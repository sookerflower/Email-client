import { Redis } from '@upstash/redis';

/**
 * Redis leader lease (Phase 3.2.3 of MIGRATION-PLAN.md).
 *
 * Exactly one worker instance may hold the IDLE watchers at a time —
 * duplicate watcher-holding replicas mean duplicate IMAP connections per
 * account, which is the original fail2ban trigger. The lease is an
 * EFFICIENCY guard in the Kleppmann sense: the sync it protects is
 * idempotent, so a pathological double-hold wastes connections briefly but
 * corrupts nothing; the reconciler + short TTL bound the overlap window.
 *
 * Mechanics: SET key holder NX PX ttl to acquire; renewal extends only while
 * the stored holder is still us (check-and-expire via Lua EVAL so a
 * competing acquisition is never extended by a stale renewer). On failed
 * renewal the holder demotes itself immediately (onLost) — watchers stop
 * well before the TTL lets a follower in, so handover never overlaps.
 */
export interface LeaderLeaseOptions {
  redisUrl: string;
  redisToken: string;
  holderId: string;
  onAcquired: () => void;
  onLost: () => void;
  /** Lease TTL; a dead leader's lock frees after this. */
  ttlMs?: number;
  /** Renew/attempt interval; must be well under ttlMs. */
  intervalMs?: number;
  key?: string;
}

export interface LeaderLease {
  isLeader(): boolean;
  release(): Promise<void>;
  stop(): void;
}

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end`;

export function startLeaderLease(options: LeaderLeaseOptions): LeaderLease {
  const {
    redisUrl,
    redisToken,
    holderId,
    onAcquired,
    onLost,
    ttlMs = 15_000,
    intervalMs = 5_000,
    key = 'mail-worker:leader',
  } = options;

  if (!redisUrl) throw new Error('leader lease requires REDIS_URL');

  const redis = new Redis({ url: redisUrl, token: redisToken });
  let leader = false;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      if (leader) {
        const renewed = (await redis.eval(RENEW_SCRIPT, [key], [holderId, ttlMs])) as number;
        if (renewed !== 1) {
          leader = false;
          onLost();
        }
      } else {
        const acquired = await redis.set(key, holderId, { nx: true, px: ttlMs });
        if (acquired === 'OK') {
          leader = true;
          onAcquired();
        }
      }
    } catch (error) {
      console.warn('[leader-lease] tick failed:', (error as Error).message);
      if (leader) {
        // Can't confirm we still hold it — demote conservatively. Better to
        // drop watchers for one interval than risk two concurrent holders.
        leader = false;
        onLost();
      }
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);

  return {
    isLeader: () => leader,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    release: async () => {
      stopped = true;
      clearInterval(timer);
      if (leader) {
        leader = false;
        try {
          await redis.eval(RELEASE_SCRIPT, [key], [holderId]);
        } catch (error) {
          console.warn('[leader-lease] release failed (TTL will free it):', (error as Error).message);
        }
      }
    },
  };
}
