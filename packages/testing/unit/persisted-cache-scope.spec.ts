// @vitest-environment jsdom
/**
 * INHERITED-STATE regression leg for the shared-persisted-cache identity bug.
 *
 * The real-user defect: the IDB query cache was shared by every user on a
 * browser profile (root.tsx passed connectionId={null}, so the persister key
 * was always `zero-query-cache-default`), logout did not clear it, and
 * `connections.getDefault` was configured to never refetch — so user B's
 * session rendered user A's persisted identity (wrong account chip) and
 * drove SSE/chat with A's connectionId into a 403 loop. Every e2e suite
 * missed it because a node HTTP client has NO persisted client cache: the
 * suites always constructed fresh state, never inherited it.
 *
 * This spec inherits state on purpose, through the REAL modules:
 *   1. "User A's session": render the real `ServerProviders` with
 *      connectionId={null} — exactly the pre-fix root wiring, which is also
 *      the historical writer of every poisoned cache — with the network
 *      answering connection A. The real persister writes A's getDefault
 *      into the (mocked, in-memory) IDB under the shared key.
 *   2. "Logout without cleanup, then user B logs in": swap the network to
 *      answer connection B, keep the IDB contents.
 *   3. Render the app's REAL root `Layout` and read the identity that
 *      `useActiveConnection` serves.
 *
 * Post-fix, Layout resolves the connection through a plain fetch before
 * mounting providers, so the probe MUST show B. Against pre-fix root.tsx
 * (ServerProviders connectionId={null} inline), the rehydrated entry is
 * served without a refetch and the probe shows A — this spec fails, which
 * is the point: it goes red on the exact code that shipped the bug.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';

// ---- module mocks (everything root.tsx pulls in that is not under test) ----

// In-memory stand-in for the browser's IndexedDB store. The persister under
// test does real reads/writes against it; the map SURVIVES between renders,
// which is precisely the inherited state this leg exists to exercise.
const idbStore = new Map<IDBValidKey, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (k: IDBValidKey) => idbStore.get(k),
  set: async (k: IDBValidKey, v: unknown) => void idbStore.set(k, v),
  del: async (k: IDBValidKey) => void idbStore.delete(k),
  clear: async () => void idbStore.clear(),
}));

vi.mock('react-router', () => ({
  Links: () => null,
  Meta: () => null,
  Outlet: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
  useNavigate: () => () => {},
  isRouteErrorResponse: () => false,
}));
vi.mock('@dub/analytics/react', () => ({ Analytics: () => null }));
vi.mock('@/providers/client-providers', () => ({
  ClientProviders: ({ children }: PropsWithChildren) => children,
}));
vi.mock('@/lib/auth-client', () => ({ signOut: async () => {} }));
vi.mock('@/paraglide/runtime', () => ({ getLocale: () => 'en' }));
vi.mock('@/paraglide/messages', () => ({
  m: new Proxy({}, { get: () => () => '' }),
}));
vi.mock('@/app/globals.css', () => ({}));

const connA = {
  id: 'conn-a-1111',
  email: 'student-a@classroom.test',
  name: null,
  picture: null,
  createdAt: null,
  providerId: 'imap',
};
const connB = {
  id: 'conn-b-2222',
  email: 'student-b@classroom.test',
  name: null,
  picture: null,
  createdAt: null,
  providerId: 'imap',
};

/** Batch-shaped tRPC answer for connections.getDefault. */
let activeSessionConnection = connA;
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('connections.getDefault')) {
    return new Response(
      JSON.stringify([{ result: { data: { json: activeSessionConnection } } }]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  // Anything else the providers ask for: empty success, never an identity.
  return new Response(JSON.stringify([{ result: { data: { json: null } } }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
vi.stubGlobal('fetch', fetchMock);
vi.stubEnv('VITE_PUBLIC_BACKEND_URL', 'http://localhost:8787');

// Imported AFTER the mocks so the real modules bind to them.
const { ServerProviders } = await import('../../../apps/mail/providers/server-providers');
const { useActiveConnection } = await import('../../../apps/mail/hooks/use-connections');
const { Layout } = await import('../../../apps/mail/app/root');

function Probe() {
  const { data } = useActiveConnection();
  return createElement('div', { 'data-testid': 'probe' }, data?.email ?? 'resolving');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('persisted query cache identity scoping (inherited state)', () => {
  beforeEach(() => {
    fetchMock.mockClear();
  });

  it('a session must never render another user identity from the shared persisted cache', async () => {
    // 1. User A's era: the historical (pre-fix) wiring persists A's
    //    getDefault into the shared key. This is the real persister writing
    //    through the real provider — not a hand-built payload.
    activeSessionConnection = connA;
    const a = render(
      createElement(ServerProviders, { connectionId: null }, createElement(Probe)),
    );
    await screen.findByText(connA.email, undefined, { timeout: 5000 });
    // persistQueryClient throttles writes; give it a beat to hit "IDB".
    await sleep(1200);
    a.unmount();
    cleanup();
    expect(idbStore.size).toBeGreaterThan(0); // the poison exists

    // 2. Logout WITHOUT cleanup (the historical path), then user B's
    //    session: the server now answers B for every identity question.
    activeSessionConnection = connB;

    // 3. The app's real root wiring decides which identity B sees.
    render(createElement(Layout, null, createElement(Probe)));
    const probe = await screen.findByTestId('probe', undefined, { timeout: 5000 });
    // Give any rehydration/refetch race time to settle before judging.
    await sleep(1500);
    expect(probe.textContent).toBe(connB.email);
  });
});
