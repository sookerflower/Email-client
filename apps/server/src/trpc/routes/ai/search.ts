import {
  GmailSearchAssistantSystemPrompt,
  ImapSearchAssistantSystemPrompt,
  OutlookSearchAssistantSystemPrompt,
} from '../../../lib/prompts';
import { activeDriverProcedure } from '../../trpc';
import { openai } from '../../../lib/ai-provider';
import { generateObject } from 'ai';
import { env } from '../../../env';
import { z } from 'zod';

export const generateSearchQuery = activeDriverProcedure
  .input(z.object({ query: z.string() }))
  .mutation(async ({ input, ctx }) => {
    const {
      activeConnection: { providerId },
    } = ctx;
    // Every other provider is the self-hosted IMAP/SMTP path, which is the
    // default deployment here. This used to fall through to '' -- the model
    // was asked to produce a search query with no instructions at all.
    const systemPrompt =
      providerId === 'google'
        ? GmailSearchAssistantSystemPrompt()
        : providerId === 'microsoft'
          ? OutlookSearchAssistantSystemPrompt()
          : ImapSearchAssistantSystemPrompt();

    const result = await generateObject({
      model: openai(env.OPENAI_MODEL || 'gpt-4o'),
      system: systemPrompt,
      prompt: input.query,
      schema: z.object({
        query: z.string(),
      }),
      output: 'object',
    });

    return result.object;
  });
