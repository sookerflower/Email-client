/**
 * Node-side stand-in for the `cloudflare:workers` module so worker code can
 * be exercised under plain Node (vitest). Only what the driver graph touches.
 */
const kvStore = new Map<string, string>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const env: any = new Proxy(
  {
    connection_labels: {
      async get(key: string) {
        return kvStore.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kvStore.set(key, value);
      },
    },
  },
  {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      return undefined;
    },
  },
);

export class DurableObject {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
