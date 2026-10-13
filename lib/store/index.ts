import { config } from "@/lib/config";
import { createMemoryStore } from "./memory";
import { createRedisStore } from "./redis";
import type { Store } from "./types";

export type { Store } from "./types";

export class StoreNotConfiguredError extends Error {
  constructor() {
    super(
      "No storage configured. On Vercel, connect a Redis database (Storage tab → Upstash Redis) so REDIS_URL is set, then redeploy."
    );
    this.name = "StoreNotConfiguredError";
  }
}

let store: Store | undefined;

/**
 * Redis when REDIS_URL (or KV_URL) is set, in-memory otherwise.
 * In-memory on Vercel would look like it works and then silently drop live
 * updates (the capture and the stream land on different instances), so we
 * fail loudly there instead.
 */
export function getStore(): Store {
  if (store) return store;
  if (config.redisUrl) {
    store = createRedisStore();
  } else if (config.onVercel) {
    throw new StoreNotConfiguredError();
  } else {
    store = createMemoryStore();
  }
  return store;
}
