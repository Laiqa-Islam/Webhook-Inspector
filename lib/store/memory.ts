import { EventEmitter } from "events";
import { config } from "@/lib/config";
import type { BinEvent, CapturedRequest } from "@/lib/types";
import type { Store } from "./types";

// Bins live in a Map on globalThis so they survive Next.js dev hot reloads
// (each reload re-evaluates modules, but the process and globalThis persist).
// Only valid while every request is handled by this one process: on Vercel,
// requests are spread across instances that don't share memory.

interface MemoryBin {
  createdAt: number;
  lastActivity: number;
  requests: CapturedRequest[];
}

interface MemoryState {
  bins: Map<string, MemoryBin>;
  emitter: EventEmitter;
  counters: Map<string, { count: number; resetAt: number }>;
}

const MAX_BINS = 500;

const g = globalThis as typeof globalThis & { __hookscopeMemory?: MemoryState };

function state(): MemoryState {
  if (!g.__hookscopeMemory) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0); // one listener per open live stream
    g.__hookscopeMemory = { bins: new Map(), emitter, counters: new Map() };
  }
  return g.__hookscopeMemory;
}

function sweep(s: MemoryState) {
  const cutoff = Date.now() - config.binTtlHours * 3600_000;
  for (const [id, bin] of s.bins) {
    if (bin.lastActivity < cutoff) s.bins.delete(id);
  }
  // Map iterates in insertion order, so the first keys are the oldest bins.
  while (s.bins.size >= MAX_BINS) {
    const oldest = s.bins.keys().next().value;
    if (!oldest) break;
    s.bins.delete(oldest);
  }
}

function touch(s: MemoryState, id: string): MemoryBin {
  let bin = s.bins.get(id);
  if (!bin) {
    sweep(s);
    bin = { createdAt: Date.now(), lastActivity: Date.now(), requests: [] };
    s.bins.set(id, bin);
  }
  bin.lastActivity = Date.now();
  return bin;
}

export function createMemoryStore(): Store {
  const s = state();

  return {
    kind: "memory",

    async createBin(id) {
      const bin = touch(s, id);
      return { id, createdAt: bin.createdAt };
    },

    async getBin(id) {
      const bin = touch(s, id);
      return { createdAt: bin.createdAt, requests: bin.requests };
    },

    async addRequest(req) {
      const bin = touch(s, req.binId);
      bin.requests.unshift(req);
      if (bin.requests.length > config.maxRequestsPerBin) {
        bin.requests.length = config.maxRequestsPerBin;
      }
      s.emitter.emit(req.binId, { type: "request", request: req } satisfies BinEvent);
    },

    async clearBin(id) {
      const bin = s.bins.get(id);
      if (bin) bin.requests = [];
      s.emitter.emit(id, { type: "cleared" } satisfies BinEvent);
    },

    async findRequest(binId, requestId) {
      return s.bins.get(binId)?.requests.find((r) => r.id === requestId);
    },

    async subscribe(binId, onEvent) {
      s.emitter.on(binId, onEvent);
      return () => {
        s.emitter.off(binId, onEvent);
      };
    },

    async hit(key, windowSeconds) {
      const now = Date.now();
      const entry = s.counters.get(key);
      if (!entry || entry.resetAt <= now) {
        if (s.counters.size > 10_000) {
          for (const [k, v] of s.counters) if (v.resetAt <= now) s.counters.delete(k);
        }
        s.counters.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
        return 1;
      }
      entry.count += 1;
      return entry.count;
    },
  };
}
