import { EventEmitter } from "events";
import { customAlphabet } from "nanoid";

// ---------------------------------------------------------------------------
// In-memory store. Bins and their captured requests live in module-level maps
// stashed on globalThis so they survive Next.js dev-mode hot reloads (each
// reload creates a fresh module instance, but globalThis persists per process).
// Nothing is written to disk: restart the server and all bins are gone, which
// is exactly the lifecycle a throwaway debugging tool wants.
// ---------------------------------------------------------------------------

export interface CapturedRequest {
  id: string;
  binId: string;
  method: string;
  /** Path after /api/hook/<binId>, including query string. "/" when bare. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Body as text, or base64 when the payload isn't valid UTF-8. */
  body: string;
  bodyEncoding: "utf8" | "base64" | "none";
  bodyTruncated: boolean;
  contentType: string | null;
  size: number;
  ip: string | null;
  receivedAt: number;
}

export interface Bin {
  id: string;
  createdAt: number;
  requests: CapturedRequest[];
}

const MAX_REQUESTS_PER_BIN = 500;
const MAX_BINS = 200;

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 10);
export const newRequestId = customAlphabet(
  "abcdefghijklmnopqrstuvwxyz0123456789",
  14
);

interface GlobalStore {
  bins: Map<string, Bin>;
  emitter: EventEmitter;
}

const g = globalThis as typeof globalThis & { __webhookStore?: GlobalStore };

if (!g.__webhookStore) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // one listener per open SSE connection
  g.__webhookStore = { bins: new Map(), emitter };
}

const store = g.__webhookStore;

export function createBin(): Bin {
  // Drop the oldest bin if we're at capacity (Map iterates in insertion order).
  if (store.bins.size >= MAX_BINS) {
    const oldest = store.bins.keys().next().value;
    if (oldest) store.bins.delete(oldest);
  }
  const bin: Bin = { id: nanoid(), createdAt: Date.now(), requests: [] };
  store.bins.set(bin.id, bin);
  return bin;
}

/** Returns the bin, creating it on first touch so URLs keep working after a restart. */
export function getOrCreateBin(id: string): Bin {
  let bin = store.bins.get(id);
  if (!bin) {
    bin = { id, createdAt: Date.now(), requests: [] };
    store.bins.set(id, bin);
  }
  return bin;
}

export function getBin(id: string): Bin | undefined {
  return store.bins.get(id);
}

export function addRequest(req: CapturedRequest): void {
  const bin = getOrCreateBin(req.binId);
  bin.requests.unshift(req); // newest first
  if (bin.requests.length > MAX_REQUESTS_PER_BIN) bin.requests.pop();
  store.emitter.emit(`bin:${req.binId}`, req);
}

export function clearBin(id: string): void {
  const bin = store.bins.get(id);
  if (bin) bin.requests = [];
  store.emitter.emit(`bin:${id}:cleared`);
}

export function findRequest(
  binId: string,
  requestId: string
): CapturedRequest | undefined {
  return store.bins.get(binId)?.requests.find((r) => r.id === requestId);
}

export function subscribe(
  binId: string,
  onRequest: (req: CapturedRequest) => void,
  onCleared: () => void
): () => void {
  store.emitter.on(`bin:${binId}`, onRequest);
  store.emitter.on(`bin:${binId}:cleared`, onCleared);
  return () => {
    store.emitter.off(`bin:${binId}`, onRequest);
    store.emitter.off(`bin:${binId}:cleared`, onCleared);
  };
}
