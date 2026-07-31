import {
  GmailSearchAssistantSystemPrompt,
  ImapSearchAssistantSystemPrompt,
  OutlookSearchAssistantSystemPrompt,
} from '../../../lib/prompts';
import { activeDriverProcedure } from '../../trpc';
import { openai } from '../../../lib/ai-provider';
import { generateText, tool } from 'ai';
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

    // Structured output via an EXPLICITLY NAMED tool, not generateObject.
    //
    // generateObject's tool mode sends `tool_choice: 'required'`, which the
    // self-hosted OpenAI-compatible endpoint silently ignores -- it returns
    // empty content and no tool call, surfacing as "No object generated: the
    // tool was not called". Probed directly against the endpoint:
    //   tool_choice omitted    -> no tool call, empty content
    //   tool_choice 'auto'     -> no tool call, empty content
    //   tool_choice 'required' -> no tool call, empty content
    //   tool_choice {name}     -> correct tool call, valid JSON arguments
    // So this is a request-shape incompatibility, NOT a model capability
    // limit. Naming the tool is what makes it work.
    const searchQuerySchema = z.object({ query: z.string() });

    const result = await generateText({
      model: openai(env.OPENAI_MODEL || 'gpt-4o'),
      system: systemPrompt,
      prompt: input.query,
      tools: {
        emit_search_query: tool({
          description: 'Return the search query string for the request.',
          parameters: searchQuerySchema,
        }),
      },
      toolChoice: { type: 'tool', toolName: 'emit_search_query' },
    });

    const call = result.toolCalls?.find((c) => c.toolName === 'emit_search_query');
    if (call) {
      return searchQuerySchema.parse(call.args);
    }

    // Text fallback. Measured behaviour of qwen2.5:32b behind ws.re.cx: with a
    // short system prompt it honours the named tool_choice, but with a
    // substantial instructional prompt (~2.6k chars, i.e. ours) it ignores the
    // forced call and returns the query as plain content instead. The content
    // is CORRECT -- it is the delivery shape that varies -- so treat a bare
    // text answer as valid rather than failing a search the model actually
    // answered. This is the "narrates a tool call as text" behaviour noted in
    // CLAUDE.md.
    const text = (result.text ?? '')
      .trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/```$/, '')
      .split('\n')[0]
      .trim();

    if (!text) {
      throw new Error('search query generation returned neither a tool call nor text');
    }
    return searchQuerySchema.parse({ query: text });
  });
