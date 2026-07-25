import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  connectBeacons,
  handleBeaconMessage,
  type BeaconEventSource,
} from '../../apps/mail/lib/realtime-beacons';

/**
 * Locks the Phase 5.2 client beacon behavior (MIGRATION-PLAN §8b):
 *  - per-type React Query invalidations, identical to the old WS onMessage
 *  - Do_State routed to the jotai setter, not an invalidation
 *  - EVERY successful open after the first fires onReconnect — the blanket
 *    active-folder invalidation that heals beacons missed while down
 *  - a CLOSED EventSource (server restart) is recreated after the retry
 *    delay; a CONNECTING one is left to the browser's native retry
 */

class FakeEventSource implements BeaconEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  emitOpen() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
  }
  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  emitFatalError() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.({});
  }
  emitTransientError() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.({});
  }
}

const makeDeps = () => {
  const deps = {
    invalidateMailGet: vi.fn(),
    invalidateMailList: vi.fn(),
    invalidateLabels: vi.fn(),
    setDoState: vi.fn(),
  };
  return deps;
};

describe('handleBeaconMessage (per-type routing, moved from WS onMessage)', () => {
  it('Mail_Get invalidates the thread query for that threadId', () => {
    const deps = makeDeps();
    handleBeaconMessage(JSON.stringify({ type: 'zero_mail_get_thread', threadId: 't-1' }), deps);
    expect(deps.invalidateMailGet).toHaveBeenCalledWith('t-1');
    expect(deps.invalidateMailGet).toHaveBeenCalledTimes(1);
    expect(deps.invalidateMailList).not.toHaveBeenCalled();
  });

  it('Mail_List invalidates the list queries for that folder', () => {
    const deps = makeDeps();
    handleBeaconMessage(JSON.stringify({ type: 'zero_mail_list_threads', folder: 'inbox' }), deps);
    expect(deps.invalidateMailList).toHaveBeenCalledWith('inbox');
    expect(deps.invalidateMailList).toHaveBeenCalledTimes(1);
    expect(deps.invalidateMailGet).not.toHaveBeenCalled();
  });

  it('User_Topics invalidates labels', () => {
    const deps = makeDeps();
    handleBeaconMessage(JSON.stringify({ type: 'zero_user_topics' }), deps);
    expect(deps.invalidateLabels).toHaveBeenCalledTimes(1);
  });

  it('Do_State routes to the jotai setter, not an invalidation', () => {
    const deps = makeDeps();
    handleBeaconMessage(
      JSON.stringify({
        type: 'zero_do_state',
        isSyncing: false,
        syncingFolders: ['inbox'],
        storageSize: 42,
        counts: null,
        shards: 0,
      }),
      deps,
    );
    expect(deps.invalidateMailGet).not.toHaveBeenCalled();
    expect(deps.invalidateMailList).not.toHaveBeenCalled();
    expect(deps.setDoState).toHaveBeenCalledWith({
      isSyncing: false,
      syncingFolders: ['inbox'],
      storageSize: 42,
      counts: [],
      shards: 0,
    });
  });

  it('malformed payloads are swallowed (never throw into the stream handler)', () => {
    const deps = makeDeps();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => handleBeaconMessage('not json', deps)).not.toThrow();
    expect(deps.invalidateMailGet).not.toHaveBeenCalled();
    expect(deps.invalidateMailList).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('connectBeacons (open -> error -> reopen reconnect discipline)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const harness = () => {
    const sources: FakeEventSource[] = [];
    const onMessage = vi.fn();
    const onReconnect = vi.fn();
    const connection = connectBeacons({
      url: 'http://test/realtime/c-1',
      makeEventSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
      onMessage,
      onReconnect,
      retryDelayMs: 1000,
    });
    return { sources, onMessage, onReconnect, connection };
  };

  it('first open is NOT a reconnect; messages flow to onMessage', () => {
    const { sources, onMessage, onReconnect } = harness();
    expect(sources).toHaveLength(1);
    sources[0]!.emitOpen();
    expect(onReconnect).not.toHaveBeenCalled();
    sources[0]!.emitMessage({ type: 'zero_mail_get_thread', threadId: 't-9' });
    expect(onMessage).toHaveBeenCalledWith(
      JSON.stringify({ type: 'zero_mail_get_thread', threadId: 't-9' }),
    );
  });

  it('open -> fatal error -> recreated source -> reopen fires the blanket reconnect', () => {
    const { sources, onReconnect } = harness();
    sources[0]!.emitOpen();

    sources[0]!.emitFatalError();
    expect(sources).toHaveLength(1); // recreation waits for the retry delay
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    expect(sources[0]!.closed).toBe(true);

    expect(onReconnect).not.toHaveBeenCalled(); // not until the new stream OPENS
    sources[1]!.emitOpen();
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('native (CONNECTING) retry that reopens also fires the reconnect', () => {
    const { sources, onReconnect } = harness();
    sources[0]!.emitOpen();
    sources[0]!.emitTransientError(); // browser retries the SAME source
    expect(sources).toHaveLength(1);
    sources[0]!.emitOpen();
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('close() stops recreation and message delivery', () => {
    const { sources, onMessage, onReconnect, connection } = harness();
    sources[0]!.emitOpen();
    connection.close();
    expect(sources[0]!.closed).toBe(true);
    sources[0]!.emitFatalError();
    vi.advanceTimersByTime(5000);
    expect(sources).toHaveLength(1); // no recreation after close
    sources[0]!.emitMessage({ type: 'zero_mail_get_thread', threadId: 't-1' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
  });
});
