import { subscriptionStore, labelConfigStore, promptStore } from '../../lib/stores';
import { getOrGenerateThreadSummary } from '../../lib/summary-service';
import { disableBrainFunction, getPrompts } from '../../lib/brain';
import { EProviders, EPrompts, type ISubscribeBatch } from '../../types';
import { activeConnectionProcedure, router } from '../trpc';
import { setSubscribedState } from '../../lib/utils';
import { env } from '../../env';
import { z } from 'zod';

const labelSchema = z.object({
  name: z.string(),
  usecase: z.string(),
});

const labelsSchema = z.array(labelSchema);

export const brainRouter = router({
  enableBrain: activeConnectionProcedure.mutation(async ({ ctx }) => {
    const connection = ctx.activeConnection as { id: string; providerId: EProviders };
    await setSubscribedState(connection.id, connection.providerId);
    await env.subscribe_queue.send({
      connectionId: connection.id,
      providerId: connection.providerId,
    } as ISubscribeBatch);
    return true;
    // return await enableBrainFunction(connection);
  }),
  disableBrain: activeConnectionProcedure.mutation(async ({ ctx }) => {
    const connection = ctx.activeConnection as { id: string; providerId: EProviders };
    return await disableBrainFunction(connection);
  }),

  generateSummary: activeConnectionProcedure
    .input(
      z.object({
        threadId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { threadId } = input;
      // Phase 3.3: Vectorize + Workers-AI replaced by the self-hosted LLM
      // writing/reading the mail0_summary table. Response shape unchanged.
      const short = await getOrGenerateThreadSummary(ctx.activeConnection.id, threadId);
      if (!short) return null;
      return {
        data: {
          short,
        },
      };
    }),
  getState: activeConnectionProcedure.query(async ({ ctx }) => {
    const connection = ctx.activeConnection;
    const enabled = await subscriptionStore.isSubscribed(connection.id, connection.providerId);
    return { enabled };
  }),
  getLabels: activeConnectionProcedure
    .output(
      z.array(
        z.object({
          name: z.string(),
          usecase: z.string(),
        }),
      ),
    )
    .query(async ({ ctx }) => {
      const connection = ctx.activeConnection;
      try {
        const labels = await labelConfigStore.get(connection.id);
        return (labels ?? []) as z.infer<typeof labelsSchema>;
      } catch (error) {
        console.error(`[GET_LABELS] Error reading labels for ${connection.id}:`, error);
        return [];
      }
    }),
  getPrompts: activeConnectionProcedure.query(async ({ ctx }) => {
    const connection = ctx.activeConnection;
    return await getPrompts({ connectionId: connection.id });
  }),
  updatePrompt: activeConnectionProcedure
    .input(
      z.object({
        promptType: z.nativeEnum(EPrompts),
        content: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const connection = ctx.activeConnection;

      const promptName = `${connection.id}-${input.promptType}`;

      await promptStore.set(promptName, input.content);

      return { success: true };
    }),
  updateLabels: activeConnectionProcedure
    .input(
      z.object({
        labels: labelsSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const connection = ctx.activeConnection;
      console.log(input.labels);

      const labels = labelsSchema.parse(input.labels);
      console.log(labels);

      await labelConfigStore.set(connection.id, labels);
      return { success: true };
    }),
});
