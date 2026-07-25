import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { env } from '../env';

/**
 * Central OpenAI-compatible model provider.
 *
 * The default `openai` export from @ai-sdk/openai (v1.x) hardcodes
 * api.openai.com and ignores OPENAI_BASE_URL, so a self-hosted
 * OpenAI-compatible endpoint (Ollama, vLLM, ...) silently never gets used.
 * This wrapper builds the provider against env.OPENAI_BASE_URL and remaps
 * hardcoded OpenAI model ids (gpt-4o etc.) to the configured models, so
 * legacy call sites keep working against the custom endpoint.
 *
 * Import `openai` from here instead of '@ai-sdk/openai'.
 */

let cached: OpenAIProvider | null = null;

const provider = (): OpenAIProvider => {
  if (!cached) {
    cached = createOpenAI({
      baseURL: env.OPENAI_BASE_URL || undefined,
      apiKey: env.OPENAI_API_KEY,
    });
  }
  return cached;
};

const isOpenAiModelId = (modelId: string) =>
  modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3');

const resolveModelId = (modelId: string): string => {
  // Without a custom endpoint, behave exactly as before.
  if (!env.OPENAI_BASE_URL) return modelId;
  if (!isOpenAiModelId(modelId)) return modelId;
  if (modelId.includes('mini')) return env.OPENAI_MINI_MODEL || env.OPENAI_MODEL || modelId;
  return env.OPENAI_MODEL || modelId;
};

export const openai = (modelId: string) => provider()(resolveModelId(modelId));
