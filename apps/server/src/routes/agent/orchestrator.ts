import { streamText, tool, type DataStreamWriter, type ToolSet } from 'ai';
import { perplexity } from '@ai-sdk/perplexity';

import { Tools } from '../../types';
import { z } from 'zod';

/**
 * Orchestrator that handles the distinction between tools and agents.
 * Tools execute and return results, while agents stream responses directly.
 */
export class ToolOrchestrator {
  private dataStream: DataStreamWriter;
  private streamingTools: Set<string> = new Set([Tools.WebSearch]);
  private connectionId: string;

  constructor(dataStream: DataStreamWriter, connectionId: string) {
    this.dataStream = dataStream;
    this.connectionId = connectionId;
  }

  /**
   * Determines if a tool should be treated as an agent that streams
   */
  isStreamingTool(toolName: string): boolean {
    return this.streamingTools.has(toolName);
  }

  /**
   * Creates a streaming agent wrapper for tools that should stream responses directly
   */
  createStreamingAgent(toolName: string, originalTool: any) {
    if (!this.isStreamingTool(toolName)) {
      return originalTool;
    }

    // For webSearch, we want to stream the response directly without wrapping it as a tool result
    if (toolName === Tools.WebSearch) {
      return tool({
        description: 'Search the web for information using Perplexity AI',
        parameters: z.object({
          query: z.string().describe('The query to search the web for'),
        }),
        execute: async ({ query }, { toolCallId }) => {
          try {
            const response = streamText({
              model: perplexity('sonar'),
              messages: [
                { role: 'system', content: 'Be precise and concise.' },
                { role: 'system', content: 'Do not include sources in your response.' },
                { role: 'system', content: 'Do not use markdown formatting in your response.' },
                { role: 'user', content: query },
              ],
              maxTokens: 1024,
            });

            // Stream the response directly to the data stream
            response.mergeIntoDataStream(this.dataStream);

            // Return a placeholder result since the actual streaming happens above
            return { type: 'streaming_response', toolName, toolCallId };
          } catch (error) {
            console.error('Error searching the web:', error);
            throw new Error('Failed to search the web');
          }
        },
      });
    }

    // InboxRag is deliberately NOT overridden here any more. The override was
    // an unlogged byte-for-byte duplicate of the tools.ts version, which made
    // every chat search invisible in the logs — diagnosing "chat says the
    // inbox is empty" took a database dig that one console.log would have
    // spared. The tools.ts version (with logging and the informative
    // match/folder counts) is the single implementation now.
    return originalTool;
  }

  /**
   * Processes all tools and returns modified versions for streaming tools
   */
  processTools<T extends ToolSet>(tools: T): T {
    const processedTools = { ...tools };

    for (const [toolName, toolInstance] of Object.entries(tools)) {
      if (this.isStreamingTool(toolName)) {
        processedTools[toolName as keyof T] = this.createStreamingAgent(toolName, toolInstance);
      }
    }

    return processedTools;
  }
}
