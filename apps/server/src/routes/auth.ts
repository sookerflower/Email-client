import { authProviders, customProviders, isProviderEnabled } from '../lib/auth-providers';
import { getZeroAgent } from '../lib/server-utils';
import type { HonoContext } from '../ctx';
import { env } from '../env';
import { Hono } from 'hono';

const publicRouter = new Hono<HonoContext>();

/**
 * New-mail callback from the IMAP transport sidecar (IDLE/poll watcher).
 * Guarded by the shared sidecar secret; triggers the standard sync workflow
 * for the connection so fresh messages appear without user interaction.
 */
publicRouter.post('/imap-notify', async (c) => {
  const secret = c.req.header('x-imap-sidecar-secret');
  if (!env.IMAP_SIDECAR_SECRET || secret !== env.IMAP_SIDECAR_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await c.req.json().catch(() => ({}))) as any;
  const connectionId = body?.connectionId;
  if (!connectionId || typeof connectionId !== 'string') {
    return c.json({ error: 'connectionId required' }, 400);
  }
  const folder = typeof body?.folder === 'string' ? body.folder : 'inbox';

  try {
    const agent = await getZeroAgent(connectionId);
    await agent.stub.notifyNewMail(folder);
    return c.json({ ok: true });
  } catch (error) {
    console.error('[imap-notify] failed:', (error as Error).message);
    return c.json({ error: 'Failed to trigger sync' }, 500);
  }
});

publicRouter.get('/providers', async (c) => {
  const env = c.env as unknown as Record<string, string>;
  const isProd = env.NODE_ENV === 'production';

  const authProviderStatus = authProviders(env).map((provider) => {
    const envVarStatus =
      provider.envVarInfo?.map((envVar) => {
        const envVarName = envVar.name as keyof typeof env;
        return {
          name: envVar.name,
          set: !!env[envVarName],
          source: envVar.source,
          defaultValue: envVar.defaultValue,
        };
      }) || [];

    return {
      id: provider.id,
      name: provider.name,
      enabled: isProviderEnabled(provider, env),
      required: provider.required,
      envVarInfo: provider.envVarInfo,
      envVarStatus,
    };
  });

  const customProviderStatus = customProviders.map((provider) => {
    return {
      id: provider.id,
      name: provider.name,
      enabled: true,
      isCustom: provider.isCustom,
      customRedirectPath: provider.customRedirectPath,
      envVarStatus: [],
    };
  });

  const allProviders = [...customProviderStatus, ...authProviderStatus];

  return c.json({
    allProviders,
    isProd,
  });
});

export { publicRouter };
