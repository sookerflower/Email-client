/**
 * Framework-free core of the SSE beacon client (Phase 5 §8b).
 *
 * `connectBeacons` owns the EventSource lifecycle: connect, deliver
 * messages, and — the load-bearing discipline — treat every successful
 * open AFTER the first as a reconnect and report it, so the React layer
 * can fire its one blanket invalidation covering beacons missed while
 * disconnected (the JMAP "resync on reconnect" rule). Native EventSource
 * retries transient errors itself; when the browser gives up (readyState
 * CLOSED, e.g. the server restarted), we recreate the source on a fixed
 * backoff.
 *
 * Kept free of React/tRPC imports so the reconnect-invalidation behavior
 * is unit-testable in plain node (packages/testing/unit).
 */

export interface BeaconEventSource {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface ConnectBeaconsOptions {
  url: string;
  /** Injectable for tests; defaults to the platform EventSource. */
  makeEventSource?: (url: string) => BeaconEventSource;
  onMessage: (raw: string) => void;
  /** Fired on every successful open after the first. */
  onReconnect: () => void;
  /** Delay before recreating a CLOSED source (default 3 s). */
  retryDelayMs?: number;
}

export interface BeaconConnection {
  close(): void;
}

const CLOSED = 2; // EventSource.CLOSED

export function connectBeacons(options: ConnectBeaconsOptions): BeaconConnection {
  const {
    url,
    makeEventSource = (u) =>
      new EventSource(u, { withCredentials: true }) as unknown as BeaconEventSource,
    onMessage,
    onReconnect,
    retryDelayMs = 3_000,
  } = options;

  let source: BeaconEventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let hasOpenedOnce = false;
  let closed = false;

  const open = () => {
    if (closed) return;
    source = makeEventSource(url);
    source.onopen = () => {
      if (closed) return;
      if (hasOpenedOnce) {
        // Anything published while we were down is gone (pub/sub has no
        // replay) — the blanket invalidation heals it.
        onReconnect();
      }
      hasOpenedOnce = true;
    };
    source.onmessage = (event) => {
      if (!closed) onMessage(event.data);
    };
    source.onerror = () => {
      if (closed || !source) return;
      // readyState CONNECTING means the browser is already retrying on its
      // own; only a CLOSED source needs manual recreation.
      if (source.readyState === CLOSED) {
        source.close();
        source = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(open, retryDelayMs);
      }
    };
  };

  open();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      source = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Message handling — the invalidation body moved verbatim from the old
// ai-sidebar onMessage (WS). Query keys and the query client are injected
// so this stays node-testable; the React hook supplies the real tRPC keys.
// ---------------------------------------------------------------------------

/** Mirrors party.tsx IncomingMessageType (client copy of the wire enum). */
export const BeaconTypes = {
  Mail_List: 'zero_mail_list_threads',
  Mail_Get: 'zero_mail_get_thread',
  User_Topics: 'zero_user_topics',
  Do_State: 'zero_do_state',
} as const;

/** Matches components/mail/use-do-state.ts State (the jotai atom shape). */
export interface DoStatePayload {
  isSyncing: boolean;
  syncingFolders: string[];
  storageSize: number;
  counts: { label: string; count: number }[];
  shards: number;
}

/**
 * Per-type invalidation ACTIONS. The old WS onMessage invalidated
 * mail.listThreads by exact input triple {folder, labelIds, q}; live
 * browser verification (5.2) showed that misses the mounted list query —
 * that code path never actually ran on Node, and exact-key matching
 * silently breaks whenever the list hook's input shape drifts. The React
 * hook therefore implements these actions with predicate/partial matching
 * on the procedure key (folder-scoped for lists); the routing per beacon
 * type below is unchanged from the WS body.
 */
export interface BeaconHandlerDeps {
  invalidateMailGet: (threadId: string) => void;
  invalidateMailList: (folder: string) => void;
  invalidateLabels: () => void;
  setDoState: (state: DoStatePayload) => void;
}

export function handleBeaconMessage(raw: string, deps: BeaconHandlerDeps): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsedData = JSON.parse(raw) as any;
    const { type } = parsedData;
    if (type === BeaconTypes.Mail_Get) {
      deps.invalidateMailGet(parsedData.threadId);
    } else if (type === BeaconTypes.Mail_List) {
      deps.invalidateMailList(parsedData.folder);
    } else if (type === BeaconTypes.User_Topics) {
      deps.invalidateLabels();
    } else if (type === BeaconTypes.Do_State) {
      const { isSyncing, syncingFolders, storageSize, counts, shards } = parsedData;
      deps.setDoState({ isSyncing, syncingFolders, storageSize, counts: counts ?? [], shards });
    }
  } catch (error) {
    console.error('error parsing beacon message', error, { rawMessage: raw });
  }
}
