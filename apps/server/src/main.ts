import {
  toAttachmentFiles,
  type SerializedAttachment,
  type AttachmentFile,
} from './lib/attachments';
import { SyncThreadsCoordinatorWorkflow } from './workflows/sync-threads-coordinator-workflow';
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
// import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import { outboxStore, snoozeStore, subscriptionStore } from './lib/stores';
import { getZeroAgent, getZeroDB, verifyToken } from './lib/server-utils';
import { SyncThreadsWorkflow } from './workflows/sync-threads-workflow';
import { ShardRegistry, ZeroDriver } from './routes/agent';
import { ThreadSyncWorker } from './routes/agent/sync-worker';
import { oAuthDiscoveryMetadata } from 'better-auth/plugins';
import { EProviders, type IEmailSendBatch } from './types';

import { contextStorage } from 'hono/context-storage';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { enableBrainFunction } from './lib/brain';
import { trpcServer } from '@hono/trpc-server';
import { publicRouter } from './routes/auth';
import { chatRouter } from './routes/chat';
import { WorkflowRunner } from './pipelines';
import { initTracing } from './lib/tracing';
import { env, type ZeroEnv } from './env';
import type { HonoContext } from './ctx';
import { createDb } from './db';
import { createAuth } from './lib/auth';
import { aiRouter } from './routes/ai';
import { appRouter } from './trpc';
import { cors } from 'hono/cors';
import { Hono } from 'hono';


/**
 * @deprecated Replaced by `UserDb` (src/lib/user-db.ts) in Phase 1 of
 * MIGRATION-PLAN.md — ZeroDB never used DO storage; every method was a
 * Postgres query, so the DO/RPC indirection was collapsed into a plain class.
 * This empty shell exists only so wrangler.jsonc's ZERO_DB binding and DO
 * migrations still resolve on the workerd path; it is deleted together with
 * the other Durable Objects in Phase 3/6.
 */
class ZeroDB extends DurableObject<ZeroEnv> {}

// Utility function to hash IP addresses for PII protection
function hashIpAddress(ip: string | undefined): string | undefined {
  if (!ip) return undefined;

  // Simple but effective hash for IP addresses
  // This preserves uniqueness while protecting PII
  const salt = 'zero-mail-ip-salt-2024'; // Consider using env variable for production
  let hash = 0;
  const str = ip + salt;

  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Return a prefixed hex representation
  return `ip_${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

const api = new Hono<HonoContext>()
  .use(contextStorage())
  .use('*', async (c, next) => {
    // Initialize request tracing using headers (no context pollution)
    const traceId = c.req.header('X-Trace-ID') || crypto.randomUUID();
    const requestId = c.req.header('X-Request-Id') || crypto.randomUUID();

    // Set trace ID in response headers for client correlation
    c.header('X-Trace-ID', traceId);
    c.header('X-Request-ID', requestId);

    // Store trace ID in context variables for TRPC access
    c.set('traceId', traceId);
    c.set('requestId', requestId);

    const { TraceContext } = await import('./lib/trace-context');

    // Create trace for this request
    const rawIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For');
    const trace = TraceContext.createTrace(traceId, {
      requestId,
      ip: hashIpAddress(rawIp), // Hash IP address to protect PII
      userAgent: c.req.header('User-Agent'),
    });

    // Start authentication span
    const authSpan = TraceContext.startSpan(traceId, 'authentication', {
      method: c.req.method,
      url: c.req.url,
      hasAuthHeader: !!c.req.header('Authorization'),
    }, {
      'auth.method': c.req.header('Authorization') ? 'bearer_token' : 'session_cookie'
    });

    const auth = createAuth();
    c.set('auth', auth);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set('sessionUser', session?.user);

    if (c.req.header('Authorization') && !session?.user) {
      // Start token verification span
      const tokenSpan = TraceContext.startSpan(traceId, 'token_verification', {
        tokenPresent: true,
      }, {
        'auth.token_type': 'jwt'
      });

      const token = c.req.header('Authorization')?.split(' ')[1];

      if (token) {
        try {
          const localJwks = await auth.api.getJwks();
          const jwks = createLocalJWKSet(localJwks);

          const { payload } = await jwtVerify(token, jwks);
          const userId = payload.sub;

          if (userId) {
            const db = await getZeroDB(userId);
            const user = await db.findUser();
            c.set('sessionUser', user);

            TraceContext.completeSpan(traceId, tokenSpan.id, {
              success: true,
              userId,
            });
          } else {
            TraceContext.completeSpan(traceId, tokenSpan.id, {
              success: false,
              reason: 'no_user_id_in_token',
            });
          }
        } catch (error) {
          TraceContext.completeSpan(traceId, tokenSpan.id, {
            success: false,
            reason: 'token_verification_failed',
          }, error instanceof Error ? error.message : 'Unknown token error');
        }
      } else {
        TraceContext.completeSpan(traceId, tokenSpan.id, {
          success: false,
          reason: 'no_token_provided',
        });
      }
    }

    // Complete auth span
    TraceContext.completeSpan(traceId, authSpan.id, {
      authenticated: !!c.var.sessionUser,
      userId: c.var.sessionUser?.id,
      authMethod: session?.user ? 'session' : (c.req.header('Authorization') ? 'token' : 'none'),
    });

    // Update trace metadata with user info
    trace.metadata.userId = c.var.sessionUser?.id;
    trace.metadata.sessionId = c.var.sessionUser?.id || 'anonymous';

    // Start request processing span
    const requestSpan = TraceContext.startSpan(traceId, 'request_processing', {
      authenticated: !!c.var.sessionUser,
      path: new URL(c.req.url).pathname,
    });

    try {
      await next();
      // Don't complete the request span here - let TRPC middleware handle it
    } catch (error) {
      TraceContext.completeSpan(traceId, requestSpan.id, {
        success: false,

        statusCode: c.res.status,
      }, error instanceof Error ? error.message : 'Unknown request error');
      throw error;
    }
    // Note: Trace will be completed by TRPC middleware after logging

    c.set('sessionUser', undefined);
    c.set('auth', undefined as any);
  })
  .route('/ai', aiRouter)
  .route('/public', publicRouter)
  // Phase 5.3: HTTP-streaming chat. Registered BEFORE the tRPC catch-all
  // below, so /api/chat/* resolves here (5.1's SSE route couldn't do this
  // because it registers late from the Node entrypoint).
  .route('/chat', chatRouter)
  .on(['GET', 'POST', 'OPTIONS'], '/auth/*', (c) => {
    return c.var.auth.handler(c.req.raw);
  })
  .use(
    trpcServer({
      endpoint: '/api/trpc',
      router: appRouter,
      createContext: (_, c) => {
        return { c, sessionUser: c.var['sessionUser'], db: c.var['db'] };
      },
      allowMethodOverride: true,
      onError: (opts) => {
        console.error('Error in TRPC handler:', opts.error);
      },
    }),
  )
  .onError(async (err, c) => {
    if (err instanceof Response) return err;
    console.error('Error in Hono handler:', err);
    return c.json(
      {
        error: 'Internal Server Error',
        message: err instanceof Error ? err.message : 'Unknown error',
      },
      500,
    );
  });

const app = new Hono<HonoContext>()
  .use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return null;
        let hostname: string;
        try {
          hostname = new URL(origin).hostname;
        } catch {
          return null;
        }
        const cookieDomain = env.COOKIE_DOMAIN;
        if (!cookieDomain) return null;
        if (hostname === cookieDomain || hostname.endsWith('.' + cookieDomain)) {
          return origin;
        }
        return null;
      },
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['X-Zero-Redirect'],
    }),
  )
  .get('.well-known/oauth-authorization-server', async (c) => {
    const auth = createAuth();
    return oAuthDiscoveryMetadata(auth)(c.req.raw);
  })
  // Phase 5.4: the agents-SDK WS layer (agentsMiddleware) and the ZeroMCP /
  // ThinkingMCP mounts are gone — realtime is SSE (/realtime, Node layer),
  // chat is HTTP (/api/chat), and the thinking tool runs in-process. An
  // external MCP surface, if ever wanted, is a plain @modelcontextprotocol
  // Streamable-HTTP server reusing tools.ts (deliberately deferred).
  .route('/api', api)
  .get('/health', (c) => c.json({ message: 'Zero Server is Up!' }))
  .get('/', (c) => c.redirect(`${env.VITE_PUBLIC_APP_URL}`))
  .post('/a8n/notify/:providerId', async (c) => {
    const tracer = initTracing();
    const span = tracer.startSpan('a8n_notify', {
      attributes: {
        'provider.id': c.req.param('providerId'),
        'notification.type': 'email_notification',
        'http.method': c.req.method,
        'http.url': c.req.url,
      },
    });

    try {
      if (!c.req.header('Authorization')) {
        span.setAttributes({ 'auth.status': 'missing' });
        return c.json({ error: 'Unauthorized' }, { status: 401 });
      }
      if (env.DISABLE_WORKFLOWS === 'true') {
        span.setAttributes({ 'workflows.disabled': true });
        return c.json({ message: 'OK' }, { status: 200 });
      }
      const providerId = c.req.param('providerId');
      if (providerId === EProviders.google) {
        const body = await c.req.json<{ historyId: string }>();
        const subHeader = c.req.header('x-goog-pubsub-subscription-name');

        span.setAttributes({
          'history.id': body.historyId,
          'subscription.name': subHeader || 'missing',
        });

        if (!subHeader) {
          console.log('[GOOGLE] no subscription header', body);
          span.setAttributes({ 'error.type': 'missing_subscription_header' });
          return c.json({}, { status: 200 });
        }
        const isValid = await verifyToken(c.req.header('Authorization')!.split(' ')[1]);
        if (!isValid) {
          console.log('[GOOGLE] invalid request', body);
          span.setAttributes({ 'auth.status': 'invalid' });
          return c.json({}, { status: 200 });
        }

        span.setAttributes({ 'auth.status': 'valid' });

        try {
          await env.thread_queue.send({
            providerId,
            historyId: body.historyId,
            subscriptionName: subHeader,
          });
          span.setAttributes({ 'queue.message_sent': true });
        } catch (error) {
          console.error('Error sending to thread queue', error, {
            providerId,
            historyId: body.historyId,
            subscriptionName: subHeader,
          });
          span.recordException(error as Error);
          span.setStatus({ code: 2, message: (error as Error).message });
        }
        return c.json({ message: 'OK' }, { status: 200 });
      }
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: 2, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
const handler = {
  async fetch(request: Request, env: ZeroEnv, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};

// const config: ResolveConfigFn = (env: ZeroEnv) => {
//   return {
//     exporter: {
//       url: env.OTEL_EXPORTER_OTLP_ENDPOINT || 'https://api.axiom.co/v1/traces',
//       headers: env.OTEL_EXPORTER_OTLP_HEADERS
//         ? Object.fromEntries(
//             env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map((header: string) => {
//               const [key, value] = header.split('=');
//               return [key.trim(), value.trim()];
//             }),
//           )
//         : {},
//     },
//     service: {
//       name: env.OTEL_SERVICE_NAME || 'zero-email-server',
//       version: '1.0.0',
//     },
//   };
// };

export default class Entry extends WorkerEntrypoint<ZeroEnv> {
  async fetch(request: Request): Promise<Response> {
    return handler.fetch(request, this.env, this.ctx);
  }
  async queue(
    batch: MessageBatch<unknown> | { queue: string; messages: Array<{ body: IEmailSendBatch }> },
  ) {
    switch (true) {
      case batch.queue.startsWith('subscribe-queue'): {
        console.log('batch', batch);
        await Promise.all(
          batch.messages.map(async (msg: any) => {
            const connectionId = msg.body.connectionId;
            const providerId = msg.body.providerId;
            try {
              await enableBrainFunction({ id: connectionId, providerId });
            } catch (error) {
              console.error(
                `Failed to enable brain function for connection ${connectionId}:`,
                error,
              );
            }
          }),
        );
        console.log('[SUBSCRIBE_QUEUE] batch done');
        return;
      }
      case batch.queue.startsWith('send-email-queue'): {
        await Promise.all(
          batch.messages.map(async (msg: any) => {
            const { messageId, connectionId } = msg.body;

            const row = await outboxStore.getById(messageId);
            if (!row) {
              console.error(`No outbox row found for scheduled email ${messageId}`);
              return;
            }
            if (row.status === 'cancelled') {
              console.log(`Email ${messageId} cancelled – skipping send.`);
              return;
            }
            if (row.status === 'sent') {
              console.log(`Email ${messageId} already sent – skipping duplicate delivery.`);
              return;
            }

            const payload = row.payload as any;

            const agent = await getZeroAgent(connectionId, this.ctx);
            try {
              if (Array.isArray((payload as any).attachments)) {
                const attachments = (payload as any).attachments;

                const processedAttachments = await Promise.all(
                  attachments.map(
                    async (att: SerializedAttachment | AttachmentFile, index: number) => {
                      if ('arrayBuffer' in att && typeof att.arrayBuffer === 'function') {
                        return { attachment: att as AttachmentFile, index };
                      } else {
                        const processed = toAttachmentFiles([att as SerializedAttachment]);
                        return { attachment: processed[0], index };
                      }
                    },
                  ),
                );

                const orderedAttachments = Array.from({ length: attachments.length });
                processedAttachments.forEach(({ attachment, index }) => {
                  orderedAttachments[index] = attachment;
                });

                (payload as any).attachments = orderedAttachments;
              }

              if ('draftId' in (payload as any) && (payload as any).draftId) {
                const { draftId, ...rest } = payload as any;
                await agent.stub.sendDraft(draftId, rest as any);
              } else {
                await agent.stub.create(payload as any);
              }

              await outboxStore.markSent(messageId);
              console.log(`Email ${messageId} sent successfully`);
            } catch (error) {
              // Unlike the KV version (which deleted the payload and silently
              // dropped the email), the outbox row survives as 'failed'.
              console.error(`Failed to send scheduled email ${messageId}:`, error);
              await outboxStore.markFailed(
                messageId,
                error instanceof Error ? error.message : String(error),
              );
            }
          }),
        );
        return;
      }
      case batch.queue.startsWith('thread-queue'): {
        const tracer = initTracing();

        await Promise.all(
          batch.messages.map(async (msg: any) => {
            const span = tracer.startSpan('thread_queue_processing', {
              attributes: {
                'provider.id': msg.body.providerId,
                'history.id': msg.body.historyId,
                'subscription.name': msg.body.subscriptionName,
                'queue.name': batch.queue,
              },
            });

            try {
              const providerId = msg.body.providerId;
              const historyId = msg.body.historyId;
              const subscriptionName = msg.body.subscriptionName;

              const workflowRunner = env.WORKFLOW_RUNNER.get(env.WORKFLOW_RUNNER.newUniqueId());
              const result = await workflowRunner.runMainWorkflow({
                providerId,
                historyId,
                subscriptionName,
              });
              console.log('[THREAD_QUEUE] result', result);
              span.setAttributes({
                'workflow.result': typeof result === 'string' ? result : JSON.stringify(result),
                'workflow.success': true,
              });
            } catch (error) {
              console.error('Error running workflow', error);
              span.recordException(error as Error);
              span.setStatus({ code: 2, message: (error as Error).message });
            } finally {
              span.end();
            }
          }),
        );
        break;
      }
    }
  }
  async scheduled() {
    console.log('Running scheduled tasks...');

    await this.processScheduledEmails();

    await this.processExpiredSubscriptions();
  }

  private async processScheduledEmails() {
    console.log('Checking for scheduled emails ready to be queued...');
    const { send_email_queue } = this.env as { send_email_queue: Queue<IEmailSendBatch> };

    try {
      const now = Date.now();
      const twelveHoursFromNow = new Date(now + 12 * 60 * 60 * 1000);

      // Outbox rows still 'pending' and due within the queue's delay horizon
      // get a delivery timer; 'queued' marks them so the next sweep skips them.
      const due = await outboxStore.listDuePending(twelveHoursFromNow);

      for (const row of due) {
        try {
          const sendAt = row.sendAt.getTime();
          const delaySeconds = Math.max(0, Math.floor((sendAt - now) / 1000));

          console.log(`Queueing scheduled email ${row.id} with ${delaySeconds}s delay`);

          const queueBody: IEmailSendBatch = {
            messageId: row.id,
            connectionId: row.connectionId,
            sendAt,
          };

          await send_email_queue.send(queueBody, { delaySeconds });
          await outboxStore.markQueued(row.id);

          console.log(`Successfully queued scheduled email ${row.id}`);
        } catch (error) {
          console.error('Failed to process scheduled email', row.id, error);
        }
      }
    } catch (error) {
      console.error('Error processing scheduled emails:', error);
    }
  }

  private async processExpiredSubscriptions() {
    console.log('[SCHEDULED] Checking for expired subscriptions...');
    const { db, conn } = createDb(this.env.HYPERDRIVE.connectionString);
    const allAccounts = await db.query.connection.findMany({
      where: (fields, { isNotNull, and }) =>
        and(isNotNull(fields.accessToken), isNotNull(fields.refreshToken)),
    });
    await conn.end();
    console.log('[SCHEDULED] allAccounts', allAccounts.length);
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    const expiredSubscriptions: Array<{ connectionId: string; providerId: EProviders }> = [];

    const unsnoozeMap: Record<string, { threadIds: string[]; keyNames: string[] }> = {};

    try {
      const dueSnoozes = await snoozeStore.listDue(new Date());
      for (const { connectionId, threadId } of dueSnoozes) {
        if (!unsnoozeMap[connectionId]) {
          unsnoozeMap[connectionId] = { threadIds: [], keyNames: [] };
        }
        unsnoozeMap[connectionId].threadIds.push(threadId);
        unsnoozeMap[connectionId].keyNames.push(`${threadId}__${connectionId}`);
      }
    } catch (error) {
      console.error('Failed to list due snoozes', error);
    }

    // await Promise.all(
    //   Object.entries(unsnoozeMap).map(async ([connectionId, { threadIds, keyNames }]) => {
    //     try {
    //       const { stub: agent } = await getZeroAgent(connectionId, this.ctx);
    //       await agent.queue('unsnoozeThreadsHandler', { connectionId, threadIds, keyNames });
    //     } catch (error) {
    //       console.error('Failed to enqueue unsnooze tasks', { connectionId, threadIds, error });
    //     }
    //   }),
    // );

    await Promise.all(
      allAccounts.map(async ({ id, providerId }) => {
        const subscriptionDate = await subscriptionStore.getSubscribedAt(id, providerId);

        if (subscriptionDate) {
          if (subscriptionDate < fiveDaysAgo) {
            console.log(`[SCHEDULED] Found expired Google subscription for connection: ${id}`);
            expiredSubscriptions.push({ connectionId: id, providerId: providerId as EProviders });
          }
        } else {
          expiredSubscriptions.push({ connectionId: id, providerId: providerId as EProviders });
        }
      }),
    );

    // Send expired subscriptions to queue for renewal
    if (expiredSubscriptions.length > 0) {
      console.log(
        `[SCHEDULED] Sending ${expiredSubscriptions.length} expired subscriptions to renewal queue`,
      );
      await Promise.all(
        expiredSubscriptions.map(async ({ connectionId, providerId }) => {
          await this.env.subscribe_queue.send({ connectionId, providerId });
        }),
      );
    }

    console.log(
      `[SCHEDULED] Processed ${allAccounts.keys.length} accounts, found ${expiredSubscriptions.length} expired subscriptions`,
    );
  }
}

export {
  ZeroDB,
  ZeroDriver,
  WorkflowRunner,
  ThreadSyncWorker,
  SyncThreadsWorkflow,
  SyncThreadsCoordinatorWorkflow,
  ShardRegistry,
};

// Node entrypoint (src/node/entry.ts) serves the same app that workerd does.
export { app };
