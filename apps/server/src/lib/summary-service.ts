import { summary } from '../db/schema';
import { generateText } from 'ai';
import { openai } from './ai-provider';
import { createDb } from '../db';
import { eq, and } from 'drizzle-orm';
import { env } from '../env';

/**
 * Thread short-summaries (Phase 3.3 of MIGRATION-PLAN.md §7).
 *
 * Replaces the Vectorize + Workers-AI (bart) pipeline: summaries are
 * generated through the self-hosted OpenAI-compatible provider
 * (lib/ai-provider honors OPENAI_BASE_URL and remaps model ids) and stored
 * in the existing `mail0_summary` table. Thread-level rows use the threadId
 * as `messageId` (the table's PK) — the original Vectorize index was keyed
 * by threadId the same way. These rows are also the clean bolt-on point if
 * pgvector/semantic search is ever wanted (explicitly deferred).
 */

const db = () => createDb(env.HYPERDRIVE.connectionString).db;

const MAX_INPUT_CHARS = 6000;

const stripHtml = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const getOrGenerateThreadSummary = async (
  connectionId: string,
  threadId: string,
): Promise<string | null> => {
  const existing = await db().query.summary.findFirst({
    where: and(eq(summary.messageId, threadId), eq(summary.connectionId, connectionId)),
  });
  if (existing) return existing.content;

  const { getMailEngine } = await import('./mail-engine');
  const engine = await getMailEngine(connectionId);
  const thread = await engine.getThreadFromDB(threadId);
  if (!thread.latest) return null;

  const text = thread.messages
    .map(
      (m) =>
        `From: ${m.sender?.name ?? ''} <${m.sender?.email ?? ''}>\nSubject: ${m.subject}\n${stripHtml(m.decodedBody ?? '')}`,
    )
    .join('\n---\n')
    .slice(0, MAX_INPUT_CHARS);

  let content: string;
  try {
    const response = await generateText({
      model: openai(env.OPENAI_MINI_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini'),
      system:
        'Summarize the email thread in one plain-text sentence (max 30 words). ' +
        'No preamble, no markdown, no quotes — just the sentence.',
      prompt: text,
    });
    content = response.text.trim();
  } catch (error) {
    console.error(`[summary-service] generation failed for ${threadId}:`, error);
    return null;
  }
  if (!content) return null;

  const now = new Date();
  await db()
    .insert(summary)
    .values({
      messageId: threadId,
      connectionId,
      content,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: summary.messageId,
      set: { content, updatedAt: now },
    });

  return content;
};
