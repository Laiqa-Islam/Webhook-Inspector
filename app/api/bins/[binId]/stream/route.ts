import { NextRequest } from "next/server";
import { subscribe, type CapturedRequest } from "@/lib/store";

export const dynamic = "force-dynamic";

// Server-Sent Events: the browser opens one long-lived GET and we push a
// "request" event down the pipe every time the store emits for this bin.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ binId: string }> }
) {
  const { binId } = await ctx.params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      send("hello", { binId, at: Date.now() });

      const unsubscribe = subscribe(
        binId,
        (r: CapturedRequest) => send("request", r),
        () => send("cleared", {})
      );

      // Comment-line heartbeat keeps proxies from timing out the idle stream.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          closed = true;
        }
      }, 25_000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
