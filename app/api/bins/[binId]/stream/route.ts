import { NextRequest } from "next/server";
import { config } from "@/lib/config";
import { handleRouteError, isValidBinId, jsonError } from "@/lib/http";
import { getStore } from "@/lib/store";
import type { BinEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Serverless functions can't stay open forever. 300s is the Vercel Hobby
// ceiling with Fluid compute; the stream closes itself a little before that
// and the browser's EventSource reconnects on its own.
export const maxDuration = 300;

const SERVERLESS_STREAM_LIFETIME_MS = 280_000;
const HEARTBEAT_MS = 20_000;

// Server-Sent Events: the browser opens one long-lived GET and we push an
// event down it every time something happens to this bin.
export async function GET(req: NextRequest, ctx: { params: Promise<{ binId: string }> }) {
  const { binId } = await ctx.params;
  if (!isValidBinId(binId)) return jsonError(404, "Unknown bin");

  let store;
  try {
    store = getStore();
  } catch (err) {
    return handleRouteError(err);
  }

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      let unsubscribe = () => {};
      const heartbeat = setInterval(() => write(`: heartbeat\n\n`), HEARTBEAT_MS);
      const lifetime = config.onVercel
        ? setTimeout(() => cleanup(), SERVERLESS_STREAM_LIFETIME_MS)
        : undefined;

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", cleanup);

      // Ask the browser to reconnect quickly whenever the stream ends.
      write(`retry: 1500\n\n`);

      try {
        unsubscribe = await store.subscribe(binId, (e: BinEvent) => {
          if (e.type === "request") send("request", e.request);
          else send("cleared", {});
        });
      } catch (err) {
        console.error("[stream] subscribe failed", err);
        send("error", { error: "Live updates unavailable, storage unreachable" });
        cleanup();
        return;
      }
      if (closed) {
        unsubscribe(); // the client left while we were subscribing
        return;
      }

      // Sent only once the subscription is live: the client refetches the
      // backlog on "hello", so nothing that lands in between is missed.
      send("hello", { binId, at: Date.now() });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
