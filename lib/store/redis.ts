import { createClient } from "redis";
import { config } from "@/lib/config";
import type { BinEvent, CapturedRequest } from "@/lib/types";
import type { Store } from "./types";

// Redis layout (all keys expire after BIN_TTL_HOURS of inactivity):
//   hookscope:bin:<id>:requests   LIST of JSON-encoded CapturedRequest, newest first
//   hookscope:bin:<id>:created    creation timestamp
//   hookscope:bin:<id>            pub/sub channel carrying BinEvent JSON
//   hookscope:rl:<key>:<window>   rate-limit counters
//
// Two connections per serverless instance, cached on globalThis so warm
// invocations reuse them: one for normal commands, and one dedicated to
// SUBSCRIBE (a subscribed Redis connection can't run other commands). Every
// live stream on the instance shares that subscriber; node-redis tracks
// listeners per channel and only unsubscribes from Redis when the last one
// for a channel goes away.

function makeClient() {
  return createClient({
    url: config.redisUrl,
    // RESP2 is the lowest common denominator across hosted Redis providers.
    RESP: 2,
    socket: { connectTimeout: 5_000 },
  });
}

type RedisClient = ReturnType<typeof makeClient>;
type Role = "cmd" | "sub";

const g = globalThis as typeof globalThis & {
  __hookscopeRedis?: Partial<Record<Role, Promise<RedisClient>>>;
};

function client(role: Role): Promise<RedisClient> {
  const cache = (g.__hookscopeRedis ??= {});
  const existing = cache[role];
  if (existing) return existing;

  const c = makeClient();
  // Without an error listener, a dropped connection would crash the process.
  // node-redis reconnects on its own; we just log.
  c.on("error", (err: Error) => console.error(`[redis:${role}]`, err.message));

  const ready = c
    .connect()
    .then(() => c)
    .catch((err) => {
      cache[role] = undefined; // let the next call retry instead of caching the failure
      throw err;
    });
  cache[role] = ready;
  return ready;
}

const P = "hookscope:";
const requestsKey = (id: string) => `${P}bin:${id}:requests`;
const createdKey = (id: string) => `${P}bin:${id}:created`;
const channel = (id: string) => `${P}bin:${id}`;

function parseRequests(raw: string[]): CapturedRequest[] {
  const out: CapturedRequest[] = [];
  for (const item of raw) {
    try {
      out.push(JSON.parse(item));
    } catch {
      /* skip a corrupt entry rather than failing the whole bin */
    }
  }
  return out;
}

export function createRedisStore(): Store {
  const ttl = config.binTtlHours * 3600;

  return {
    kind: "redis",

    async createBin(id) {
      const r = await client("cmd");
      const createdAt = Date.now();
      await r.set(createdKey(id), String(createdAt), {
        condition: "NX",
        expiration: { type: "EX", value: ttl },
      });
      return { id, createdAt };
    },

    async getBin(id) {
      const r = await client("cmd");
      const [raw, created] = await Promise.all([
        r.lRange(requestsKey(id), 0, -1),
        r.get(createdKey(id)),
      ]);
      return {
        createdAt: created ? Number(created) : Date.now(),
        requests: parseRequests(raw),
      };
    },

    async addRequest(req) {
      const r = await client("cmd");
      const event: BinEvent = { type: "request", request: req };
      // One round trip: store, cap, refresh expiry, broadcast.
      await r
        .multi()
        .lPush(requestsKey(req.binId), JSON.stringify(req))
        .lTrim(requestsKey(req.binId), 0, config.maxRequestsPerBin - 1)
        .expire(requestsKey(req.binId), ttl)
        .set(createdKey(req.binId), String(req.receivedAt), {
          condition: "NX",
          expiration: { type: "EX", value: ttl },
        })
        .expire(createdKey(req.binId), ttl)
        .publish(channel(req.binId), JSON.stringify(event))
        .exec();
    },

    async clearBin(id) {
      const r = await client("cmd");
      const event: BinEvent = { type: "cleared" };
      await r
        .multi()
        .del(requestsKey(id))
        .publish(channel(id), JSON.stringify(event))
        .exec();
    },

    async findRequest(binId, requestId) {
      const r = await client("cmd");
      const raw = await r.lRange(requestsKey(binId), 0, -1);
      return parseRequests(raw).find((x) => x.id === requestId);
    },

    async subscribe(binId, onEvent) {
      const sub = await client("sub");
      const listener = (message: string) => {
        try {
          onEvent(JSON.parse(message) as BinEvent);
        } catch {
          /* ignore malformed messages */
        }
      };
      await sub.subscribe(channel(binId), listener);
      return () => {
        sub.unsubscribe(channel(binId), listener).catch(() => {});
      };
    },

    async hit(key, windowSeconds) {
      const r = await client("cmd");
      const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
      const k = `${P}rl:${key}:${bucket}`;
      const count = await r.incr(k);
      if (count === 1) await r.expire(k, windowSeconds + 1);
      return count;
    },
  };
}
