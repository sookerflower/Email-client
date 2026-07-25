/**
 * SSE beacon subscription (Phase 5 §8b) — replaces the agents-SDK WS as the
 * mail-invalidation transport. Handling is IDENTICAL to the old ai-sidebar
 * onMessage body (per-type React Query invalidations, Do_State → jotai);
 * only the transport changed. On every reconnect, one blanket invalidation
 * of the thread/list queries heals whatever beacons were missed while
 * disconnected — pub/sub has no replay.
 */
import { connectBeacons, handleBeaconMessage } from '@/lib/realtime-beacons';
import { useDoState } from '@/components/mail/use-do-state';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useTRPC } from '@/providers/query-provider';

/** key[0] of every tRPC tanstack query is the procedure path array. */
const isProcedure = (queryKey: readonly unknown[], path: string[]) => {
  const head = queryKey[0];
  return (
    Array.isArray(head) && head.length === path.length && path.every((p, i) => head[i] === p)
  );
};

const queryInput = (queryKey: readonly unknown[]): Record<string, unknown> | undefined =>
  (queryKey[1] as { input?: Record<string, unknown> } | undefined)?.input;

export function useRealtimeBeacons(connectionId: string | undefined) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [, setDoState] = useDoState();

  useEffect(() => {
    if (!connectionId) return;

    // Predicate matching by procedure (folder-scoped for lists) instead of
    // exact input keys: the mounted list query's input (labelIds/q shape)
    // must never be able to drift away from the invalidation — that
    // exact-key miss is precisely what live verification caught.
    const invalidateMailList = (folder: string) =>
      void queryClient.invalidateQueries({
        predicate: (query) => {
          if (!isProcedure(query.queryKey, ['mail', 'listThreads'])) return false;
          const input = queryInput(query.queryKey);
          return !folder || !input?.folder || input.folder === folder;
        },
      });

    const invalidateAllThreads = () =>
      void queryClient.invalidateQueries({
        predicate: (query) =>
          isProcedure(query.queryKey, ['mail', 'listThreads']) ||
          isProcedure(query.queryKey, ['mail', 'get']),
      });

    const handleMessage = (raw: string) =>
      handleBeaconMessage(raw, {
        invalidateMailGet: (threadId) =>
          void queryClient.invalidateQueries({
            queryKey: trpc.mail.get.queryKey({ id: threadId }),
          }),
        invalidateMailList,
        invalidateLabels: () =>
          void queryClient.invalidateQueries({ queryKey: trpc.labels.list.queryKey() }),
        setDoState,
      });

    const connection = connectBeacons({
      url: `${import.meta.env.VITE_PUBLIC_BACKEND_URL}/realtime/${connectionId}`,
      onMessage: handleMessage,
      // Blanket heal on reconnect: every list variant + every cached thread
      // goes stale; mounted ones refetch immediately.
      onReconnect: invalidateAllThreads,
    });

    return () => connection.close();
    // setDoState (jotai) and the tRPC/query clients are referentially
    // stable; the stream is keyed by connection only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);
}
