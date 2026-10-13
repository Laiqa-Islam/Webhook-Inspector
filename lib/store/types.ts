import type { BinEvent, CapturedRequest } from "@/lib/types";

/**
 * Everything the routes need from storage. Two implementations:
 * - memory: a Map + EventEmitter in one Node process (local dev, single server)
 * - redis:  lists + pub/sub, so many serverless instances share state (Vercel)
 */
export interface Store {
  readonly kind: "memory" | "redis";
  createBin(id: string): Promise<{ id: string; createdAt: number }>;
  getBin(id: string): Promise<{ createdAt: number; requests: CapturedRequest[] }>;
  addRequest(req: CapturedRequest): Promise<void>;
  clearBin(id: string): Promise<void>;
  findRequest(binId: string, requestId: string): Promise<CapturedRequest | undefined>;
  /** Resolves once the subscription is live; call the returned fn to stop. */
  subscribe(binId: string, onEvent: (e: BinEvent) => void): Promise<() => void>;
  /** Fixed-window counter for rate limiting. Returns the hit count in the current window. */
  hit(key: string, windowSeconds: number): Promise<number>;
}
