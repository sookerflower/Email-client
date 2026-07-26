/**
 * Scheduled-send handoff to the worker process (Phase 6.4 — replaces the
 * cf-shim `send_email_queue` binding stub with a plain typed helper).
 *
 * The api process cannot import BullMQ (lib/queue is worker-only); delivery
 * timers are BullMQ delayed jobs hosted by the worker, reached over its
 * /enqueue-send HTTP bridge. Throws on non-OK so callers keep their existing
 * failure semantics (outbox row stays 'pending'; the reconciliation sweep
 * recovers it at send_at).
 */
import { env } from '../env';

export async function enqueueScheduledSend(
  messageId: string,
  connectionId: string,
  sendAt: number,
): Promise<void> {
  const base = env.IMAP_SIDECAR_URL || 'http://127.0.0.1:8791';
  const res = await fetch(`${base}/enqueue-send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-imap-sidecar-secret': env.IMAP_SIDECAR_SECRET || '',
    },
    body: JSON.stringify({ messageId, connectionId, sendAt }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`enqueue-send failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}
