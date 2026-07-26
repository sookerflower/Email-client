/**
 * AI chat over plain HTTP streaming (Phase 5.3, MIGRATION-PLAN §8a).
 *
 * POST /api/chat/:connectionId — the ZeroAgent WebSocket chat ported to a
 * single Hono route: same streamText + createDataStreamResponse +
 * ToolOrchestrator + processToolCalls pipeline, but the Response is
 * RETURNED to the client (AI SDK `useChat` speaks this natively). The old
 * `reply()` WS chunk re-pump is deleted, not adapted.
 *
 * Mounted INSIDE the /api sub-app (main.ts) before its tRPC catch-all —
 * registration order makes /api/chat safe here, unlike 5.1's SSE route
 * which is registered late from the Node entrypoint and therefore lives
 * at /realtime. This module is workerd-safe (no ioredis/BullMQ).
 *
 * Auth matches the SSE endpoint (the other half of the 5.1 ownership
 * fix): better-auth session (401) + connection ownership (403; missing
 * and not-owned are both 403 so connection ids don't leak).
 *
 * Abort: the HTTP request's AbortSignal feeds streamText directly — the
 * old abort-controller map was never wired into streamText at all (dead
 * code); this is the fix, not a port.
 *
 * HITL: processToolCalls runs with a real executeFunctions map now —
 * BulkDelete is approval-gated (defined without execute; runs here only
 * on APPROVAL.YES from the client).
 *
 * Persistence: chat_message rows upserted on request (user messages) and
 * in onFinish (full exchange). History intentionally stays unloaded on
 * open — parity with today's UI; DELETE /:connectionId replaces the WS
 * cf_agent_chat_clear frame.
 */
import { appendResponseMessages, createDataStreamResponse, streamText, tool } from 'ai';
import type { Message } from 'ai';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import { tools as authTools, bulkDeleteExecute } from './agent/tools';
import { SequentialThinkingProcessor } from '../lib/sequential-thinking';
import { ToolOrchestrator } from './agent/orchestrator';
import { processToolCalls } from './agent/utils';
import { anthropic } from '@ai-sdk/anthropic';
import { AiChatPrompt } from '../lib/prompts';
import { getPrompt } from '../pipelines.effect';
import { getPromptName } from '../lib/prompts';
import { openai } from '../lib/ai-provider';
import { EPrompts, Tools } from '../types';
import { chatMessage } from '../db/schema';
import type { HonoContext } from '../ctx';
import { eq } from 'drizzle-orm';
import { createDb } from '../db';
import { env } from '../env';

/**
 * The ThinkingMCP sequentialthinking tool inlined as a plain AI SDK tool —
 * the processor is plain TS; the MCP transport indirection bought nothing.
 * One processor per request: thought history spans the steps of one
 * streamText run (maxSteps 10), which is the scope the tool needs.
 */
const sequentialThinkingTool = () => {
  const processor = new SequentialThinkingProcessor();
  return tool({
    description:
      'A detailed tool for dynamic and reflective problem-solving through thoughts. ' +
      'Helps analyze problems through a flexible thinking process that can adapt and evolve. ' +
      'Each thought can build on, question, or revise previous insights. Use for: breaking ' +
      'down complex problems, planning with room for revision, analysis that might need ' +
      'course correction, multi-step solutions, and maintaining context over multiple steps. ' +
      'Adjust total_thoughts as you go, revise or branch freely, and only set ' +
      'nextThoughtNeeded to false when truly done.',
    parameters: z.object({
      thought: z.string().describe('Your current thinking step'),
      nextThoughtNeeded: z.boolean().describe('Whether another thought step is needed'),
      thoughtNumber: z.number().int().min(1).describe('Current thought number'),
      totalThoughts: z.number().int().min(1).describe('Estimated total thoughts needed'),
      isRevision: z.boolean().optional().describe('Whether this revises previous thinking'),
      revisesThought: z.number().int().min(1).optional().describe('Which thought is reconsidered'),
      branchFromThought: z.number().int().min(1).optional().describe('Branching point'),
      branchId: z.string().optional().describe('Branch identifier'),
      needsMoreThoughts: z.boolean().optional().describe('If more thoughts are needed'),
    }),
    execute: async (params) => processor.processThought(params),
  });
};

const db = () => createDb(env.DATABASE_URL).db;

/** Upsert-by-id keeps re-sent conversations idempotent. */
async function persistChatMessages(connectionId: string, messages: Message[]): Promise<void> {
  for (const message of messages) {
    if (!message?.id) continue;
    await db()
      .insert(chatMessage)
      .values({ id: message.id, connectionId, message })
      .onConflictDoUpdate({ target: chatMessage.id, set: { message } });
  }
}

async function requireOwnedConnection(
  c: Context<HonoContext, '/:connectionId'>,
): Promise<{ connectionId: string } | Response> {
  const sessionUser = c.var.sessionUser;
  if (!sessionUser) return c.json({ error: 'Unauthorized' }, 401);
  const connectionId = c.req.param('connectionId');
  const row = await db().query.connection.findFirst({
    where: (fields, { eq: whereEq }) => whereEq(fields.id, connectionId),
    columns: { id: true, userId: true },
  });
  // Same status for missing and not-owned: don't leak which ids exist.
  if (!row || row.userId !== sessionUser.id) return c.json({ error: 'Forbidden' }, 403);
  return { connectionId };
}

// Registered non-chained so the router's type stays a plain
// Hono<HonoContext> — the accumulated route schema of a chained router
// breaks type inference for the middleware registered after
// .route('/chat', …) in main.ts.
export const chatRouter = new Hono<HonoContext>();

chatRouter.post('/:connectionId', async (c) => {
    const owned = await requireOwnedConnection(c);
    if (owned instanceof Response) return owned;
    const { connectionId } = owned;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await c.req.json().catch(() => ({}))) as any;
    const messages: Message[] = Array.isArray(body?.messages) ? body.messages : [];
    if (!messages.length) return c.json({ error: 'messages required' }, 400);
    const currentThreadId: string = body?.threadId ?? '';
    const currentFolder: string = body?.currentFolder ?? '';
    const currentFilter: string = body?.currentFilter ?? '';

    await persistChatMessages(connectionId, messages);

    // HTTP request abort -> streamText. (The WS version's abort-controller
    // map was never wired into streamText; do not port dead code.)
    const abortSignal = c.req.raw.signal;

    return createDataStreamResponse({
      execute: async (dataStream) => {
        const orchestrator = new ToolOrchestrator(dataStream, connectionId);
        const rawTools = {
          ...(await authTools(connectionId)),
          sequentialthinking: sequentialThinkingTool(),
        };
        const tools = orchestrator.processTools(rawTools);
        const processedMessages = await processToolCalls(
          { messages, dataStream, tools },
          // Approval-gated executions (HITL): run only on APPROVAL.YES.
          { [Tools.BulkDelete]: bulkDeleteExecute(connectionId) },
        );

        const model =
          env.USE_OPENAI === 'true'
            ? openai(env.OPENAI_MODEL || 'gpt-4o')
            : anthropic(env.OPENAI_MODEL || 'claude-3-7-sonnet-20250219');

        const result = streamText({
          model,
          maxSteps: 10,
          messages: processedMessages,
          tools,
          abortSignal,
          onFinish: async ({ response }) => {
            const finalMessages = appendResponseMessages({
              messages,
              responseMessages: response.messages,
            });
            await persistChatMessages(connectionId, finalMessages);
          },
          onError: (error) => {
            console.error('Error in streamText', error);
          },
          system: await getPrompt(getPromptName(connectionId, EPrompts.Chat), AiChatPrompt(), {
            currentThreadId,
            currentFolder,
            currentFilter,
          }),
        });

        result.mergeIntoDataStream(dataStream);
      },
    });
  });

// New-chat: replaces the WS cf_agent_chat_clear frame.
chatRouter.delete('/:connectionId', async (c) => {
  const owned = await requireOwnedConnection(c);
  if (owned instanceof Response) return owned;
  await db().delete(chatMessage).where(eq(chatMessage.connectionId, owned.connectionId));
  return c.json({ ok: true });
});
