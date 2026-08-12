import { getCurrentDateContext, GmailSearchAssistantSystemPrompt } from '../../lib/prompts';
import { getThread, getZeroAgent } from '../../lib/server-utils';
import type { IGetThreadResponse } from '../../lib/driver/types';
import { composeEmail } from '../../trpc/routes/ai/compose';
import { perplexity } from '@ai-sdk/perplexity';
import { colors } from '../../lib/prompts';
import { openai } from '../../lib/ai-provider';
import { generateText, tool } from 'ai';
import { Tools } from '../../types';
import { env } from '../../env';
import { z } from 'zod';

type ModelTypes = 'summarize' | 'general' | 'chat';

const _models: Record<ModelTypes, any> = {
  summarize: '@cf/facebook/bart-large-cnn',
  general: 'llama-3.3-70b-instruct-fp8-fast',
  chat: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
};

/**
 * Returns the thread's REAL fields, compactly. This used to return only a
 * `<thread id="…"/>` placeholder (a Cloudflare-era guard against bloating
 * worker state), which left the model — and the chat surface — with a bare
 * base64 id where the sender should be and "[Not Provided]" subjects. The
 * bloat concern is still honored by staying lightweight: per-message
 * envelope fields plus a truncated snippet of the latest body, never full
 * bodies for the whole thread.
 */
const getEmail = (connectionId: string) =>
  tool({
    description:
      'Get a specific email thread by ID: subject, sender, recipients, date, labels, ' +
      'message count, and a snippet of the latest message body.',
    parameters: z.object({
      id: z.string().describe('The ID of the email thread to retrieve'),
    }),
    execute: async ({ id }) => {
      console.log('[GetThread] fetching', id);
      let thread: IGetThreadResponse;
      try {
        const { result } = await getThread(connectionId, id);
        thread = result;
      } catch (error) {
        console.error('[GetThread] failed for', id, error);
        return { id, error: 'Thread not found' };
      }
      const latest = thread.latest ?? thread.messages[thread.messages.length - 1];
      const snippet = (latest?.decodedBody ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
      return {
        id,
        subject: latest?.subject ?? null,
        sender: latest?.sender ?? null,
        date: latest?.receivedOn ?? null,
        messageCount: thread.messages.length,
        hasUnread: thread.hasUnread,
        labels: thread.labels?.map((l) => l.name) ?? [],
        participants: thread.messages
          .map((m) => m.sender?.email)
          .filter((v, i, a) => v && a.indexOf(v) === i),
        latestSnippet: snippet || null,
      };
    },
  });

const getThreadSummary = (connectionId: string) =>
  tool({
    description: 'Get the summary of a specific email thread',
    parameters: z.object({
      id: z.string().describe('The ID of the email thread to get the summary of'),
    }),
    execute: async ({ id }) => {
      // Phase 3.3: Vectorize + Workers-AI replaced by the self-hosted LLM
      // reading/writing the mail0_summary table. Return shape unchanged.
      let thread: IGetThreadResponse | null = null;
      try {
        const { result } = await getThread(connectionId, id);
        thread = result;
      } catch (error) {
        console.error('Error getting thread', error);
        return { error: 'Thread not found' };
      }
      const { getOrGenerateThreadSummary } = await import('../../lib/summary-service');
      const short = await getOrGenerateThreadSummary(connectionId, id).catch(() => null);
      if (short && thread?.latest?.subject) {
        return {
          short,
          subject: thread.latest?.subject,
          sender: thread.latest?.sender,
          date: thread.latest?.receivedOn,
        };
      }
      return {
        subject: thread.latest?.subject,
        sender: thread.latest?.sender,
        date: thread.latest?.receivedOn,
      };
    },
  });

const composeEmailTool = (connectionId: string) =>
  tool({
    description: 'Compose an email using AI assistance',
    parameters: z.object({
      prompt: z.string().describe('The prompt or rough draft for the email'),
      emailSubject: z.string().optional().describe('The subject of the email'),
      to: z.array(z.string()).optional().describe('Recipients of the email'),
      cc: z.array(z.string()).optional().describe('CC recipients of the email'),
      threadMessages: z
        .array(
          z.object({
            from: z.string().describe('The sender of the email'),
            to: z.array(z.string()).describe('The recipients of the email'),
            cc: z.array(z.string()).optional().describe('The CC recipients of the email'),
            subject: z.string().describe('The subject of the email'),
            body: z.string().describe('The body of the email'),
          }),
        )
        .optional()
        .describe('Previous messages in the thread for context'),
    }),
    execute: async (data) => {
      const newBody = await composeEmail({
        ...data,
        username: 'AI Assistant',
        connectionId,
      });
      return { newBody };
    },
  });

const listEmails = (connectionId: string) =>
  tool({
    description:
      'List the newest threads in a mail folder — sender address, subject and date per ' +
      'thread, no search query. Use this for "show/list my inbox"-shaped questions ' +
      '(who emailed me, what is in my inbox/sent/archive). Folders: inbox, sent, ' +
      'drafts, archive, spam, bin, snoozed.',
    parameters: z.object({
      folder: z.string().describe("The folder to list (default 'inbox')").default('inbox'),
      maxResults: z
        .number()
        .describe('How many threads to return, 1-50 (default 20)')
        .default(20),
    }),
    execute: async ({ folder, maxResults }) => {
      console.log('[ListEmails] listing', { folder, maxResults });
      const { stub: agent } = await getZeroAgent(connectionId);
      const result = await agent.listFolderSummaries({ folder, maxResults });
      console.log('[ListEmails] returned', result.count, 'thread(s) from', result.folder);
      return result;
    },
  });

const markAsRead = (connectionId: string) =>
  tool({
    description: 'Mark emails as read',
    parameters: z.object({
      threadIds: z.array(z.string()).describe('The IDs of the threads to mark as read'),
    }),
    execute: async ({ threadIds }) => {
      const { stub: agent } = await getZeroAgent(connectionId);
      await agent.applyLabels(threadIds, [], ['UNREAD']);
      return { threadIds, success: true };
    },
  });

const markAsUnread = (connectionId: string) =>
  tool({
    description: 'Mark emails as unread',
    parameters: z.object({
      threadIds: z.array(z.string()).describe('The IDs of the threads to mark as unread'),
    }),
    execute: async ({ threadIds }) => {
      const { stub: agent } = await getZeroAgent(connectionId);
      await agent.applyLabels(threadIds, ['UNREAD'], []);
      return { threadIds, success: true };
    },
  });

const modifyLabels = (connectionId: string) =>
  tool({
    description: 'Modify labels on emails',
    parameters: z.object({
      threadIds: z.array(z.string()).describe('The IDs of the threads to modify'),
      options: z.object({
        addLabels: z
          .array(z.string())
          .default([])
          .describe('The labels to add, an array of label names'),
        removeLabels: z
          .array(z.string())
          .default([])
          .describe('The labels to remove, an array of label names'),
      }),
    }),
    execute: async ({ threadIds, options }) => {
      const { stub: agent } = await getZeroAgent(connectionId);
      await agent.applyLabels(threadIds, options.addLabels, options.removeLabels);
      return { threadIds, options, success: true };
    },
  });

const getUserLabels = (connectionId: string) =>
  tool({
    description: 'Get all user labels',
    parameters: z.object({}),
    execute: async () => {
      const { stub: agent } = await getZeroAgent(connectionId);
      return await agent.getUserLabels();
    },
  });

const sendEmail = (connectionId: string) =>
  tool({
    description: 'Send a new email',
    parameters: z.object({
      to: z.array(
        z.object({
          email: z.string().describe('The email address of the recipient'),
          name: z.string().optional().describe('The name of the recipient'),
        }),
      ),
      subject: z.string().describe('The subject of the email'),
      message: z.string().describe('The body of the email'),
      cc: z
        .array(
          z.object({
            email: z.string().describe('The email address of the recipient'),
            name: z.string().optional().describe('The name of the recipient'),
          }),
        )
        .optional(),
      bcc: z
        .array(
          z.object({
            email: z.string().describe('The email address of the recipient'),
            name: z.string().optional().describe('The name of the recipient'),
          }),
        )
        .optional(),
      threadId: z.string().optional().describe('The ID of the thread to send the email from'),
      // fromEmail: z.string().optional(),
      draftId: z.string().optional().describe('The ID of the draft to send'),
    }),
    execute: async (data) => {
      try {
        const { stub: agent } = await getZeroAgent(connectionId);
        const { draftId, ...mail } = data;

        if (draftId) {
          await agent.sendDraft(draftId, {
            ...mail,
            // The model's body is prose with \n breaks — never HTML. The
            // driver converts it (escaped) and sends multipart.
            bodyType: 'text',
            attachments: [],
            headers: {},
          });
        } else {
          await agent.create({
            ...mail,
            bodyType: 'text',
            attachments: [],
            headers: {},
          });
        }

        return { success: true };
      } catch (error) {
        console.error('Error sending email:', error);
        throw new Error(
          'Failed to send email: ' + (error instanceof Error ? error.message : String(error)),
        );
      }
    },
  });

const createLabel = (connectionId: string) =>
  tool({
    description: 'Create a new label with custom colors, if it does nto exist already',
    parameters: z.object({
      name: z.string().describe('The name of the label to create'),
      backgroundColor: z
        .string()
        .describe('The background color of the label in hex format')
        .refine((color) => colors.includes(color), {
          message: 'Background color must be one of the predefined colors',
        }),
      textColor: z
        .string()
        .describe('The text color of the label in hex format')
        .refine((color) => colors.includes(color), {
          message: 'Text color must be one of the predefined colors',
        }),
    }),
    execute: async ({ name, backgroundColor, textColor }) => {
      const { stub: agent } = await getZeroAgent(connectionId);
      await agent.createLabel({ name, color: { backgroundColor, textColor } });
      return { name, backgroundColor, textColor, success: true };
    },
  });

/**
 * Approval-gated (Phase 5.3, AI SDK HITL cookbook pattern): defined WITHOUT
 * an execute function, so the model's call surfaces to the client as a
 * pending tool invocation; the client answers APPROVAL.YES/NO and
 * processToolCalls runs `bulkDeleteExecute` from the chat route's
 * executeFunctions map only on YES. Destructive action = the one tool that
 * warrants a human in the loop.
 */
const bulkDelete = () =>
  tool({
    description:
      'Move multiple emails to trash by adding the TRASH label. Requires user confirmation before it runs.',
    parameters: z.object({
      threadIds: z.array(z.string()).describe('Array of email IDs to move to trash'),
    }),
  });

export const bulkDeleteExecute =
  (connectionId: string) =>
  async ({ threadIds }: { threadIds: string[] }) => {
    const { stub: agent } = await getZeroAgent(connectionId);
    await agent.applyLabels(threadIds, ['TRASH'], []);
    return { threadIds, success: true };
  };

const bulkArchive = (connectionId: string) =>
  tool({
    description: 'Move multiple emails to the archive by removing the INBOX label',
    parameters: z.object({
      threadIds: z.array(z.string()).describe('Array of email IDs to move to archive'),
    }),
    execute: async ({ threadIds }) => {
      const { stub: agent } = await getZeroAgent(connectionId);
      await agent.applyLabels(threadIds, [], ['INBOX']);
      return { threadIds, success: true };
    },
  });

const deleteLabel = (connectionId: string) =>
  tool({
    description: "Delete a label from the user's account",
    parameters: z.object({
      id: z.string().describe('The ID of the label to delete'),
    }),
    execute: async ({ id }) => {
      const { stub: agent } = await getZeroAgent(connectionId);
      await agent.deleteLabel(id);
      return { id, success: true };
    },
  });

const buildGmailSearchQuery = () =>
  tool({
    description: 'Build a Gmail search query',
    parameters: z.object({
      query: z.string().describe('The search query to build, provided in natural language'),
    }),
    execute: async (params) => {
      console.log('[DEBUG] buildGmailSearchQuery', params);

      const result = await generateText({
        model: openai(env.OPENAI_MODEL || 'gpt-4o'),
        system: GmailSearchAssistantSystemPrompt(),
        prompt: params.query,
      });
      return {
        content: [
          {
            type: 'text',
            text: result.text,
          },
        ],
      };
    },
  });

const getCurrentDate = () =>
  tool({
    description: 'Get the current date',
    parameters: z.object({}).default({}),
    execute: async () => {
      console.log('[DEBUG] getCurrentDate');

      return {
        content: [
          {
            type: 'text',
            text: getCurrentDateContext(),
          },
        ],
      };
    },
  });

export const webSearch = () =>
  tool({
    description: 'Search the web for information using Perplexity AI',
    parameters: z.object({
      query: z.string().describe('The query to search the web for'),
    }),
    execute: async ({ query }) => {
      try {
        const response = await generateText({
          model: perplexity('sonar'),
          messages: [
            { role: 'system', content: 'Be precise and concise.' },
            { role: 'system', content: 'Do not include sources in your response.' },
            { role: 'system', content: 'Do not use markdown formatting in your response.' },
            { role: 'user', content: query },
          ],
          maxTokens: 1024,
        });

        return response.text;
      } catch (error) {
        console.error('Error searching the web:', error);
        throw new Error('Failed to search the web');
      }
    },
  });

export const tools = async (connectionId: string) => {
  return {
    [Tools.GetThread]: getEmail(connectionId),
    [Tools.GetThreadSummary]: getThreadSummary(connectionId),
    [Tools.ComposeEmail]: composeEmailTool(connectionId),
    [Tools.MarkThreadsRead]: markAsRead(connectionId),
    [Tools.MarkThreadsUnread]: markAsUnread(connectionId),
    [Tools.ModifyLabels]: modifyLabels(connectionId),
    [Tools.GetUserLabels]: getUserLabels(connectionId),
    [Tools.SendEmail]: sendEmail(connectionId),
    [Tools.CreateLabel]: createLabel(connectionId),
    [Tools.BulkDelete]: bulkDelete(),
    [Tools.BulkArchive]: bulkArchive(connectionId),
    [Tools.DeleteLabel]: deleteLabel(connectionId),
    [Tools.BuildGmailSearchQuery]: buildGmailSearchQuery(),
    [Tools.GetCurrentDate]: getCurrentDate(),
    [Tools.ListEmails]: listEmails(connectionId),
    [Tools.WebSearch]: webSearch(),
    [Tools.InboxRag]: tool({
      description:
        'Search a folder with literal search terms (words are ANDed; operators like ' +
        'from:/subject:/is:unread supported). Returns matching threadIds plus matchCount ' +
        'and folderTotal — 0 matches with a non-zero folderTotal means the TERMS missed, ' +
        'NOT that the folder is empty. To list a folder without filtering, use listEmails.',
      parameters: z.object({
        query: z.string().describe('The query to search the inbox for'),
        maxResults: z.number().describe('The maximum number of results to return').default(10),
        folder: z.string().describe('The folder to search the inbox for').default('inbox'),
      }),
      execute: async ({ query, maxResults, folder }) => {
        console.log('[InboxRag] searching threads', { query, maxResults, folder });
        const { stub: agent } = await getZeroAgent(connectionId);
        const res = await agent.searchThreads({ query, maxResults, folder });
        console.log('[InboxRag] matched', res.matchCount, 'of', res.folderTotal, 'in', folder);
        const summary =
          res.matchCount === 0
            ? `0 matches for "${query}" in ${folder}; the folder contains ` +
              `${res.folderTotal ?? 'an unknown number of'} message(s). ` +
              (res.folderTotal
                ? 'The folder is NOT empty — the search terms matched nothing.'
                : '')
            : `${res.matchCount} match(es) for "${query}" in ${folder} ` +
              `(folder holds ${res.folderTotal ?? 'unknown'} message(s)).`;
        return {
          threadIds: res.threadIds,
          matchCount: res.matchCount,
          folderTotal: res.folderTotal,
          summary,
        };
      },
    }),
  };
};
