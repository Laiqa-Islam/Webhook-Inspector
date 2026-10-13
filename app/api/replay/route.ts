import { NextRequest, NextResponse } from "next/server";
import { findRequest } from "@/lib/store";

export const dynamic = "force-dynamic";

// Headers that describe the original connection rather than the request
// itself — forwarding them would corrupt the replayed request (wrong Host,
// stale Content-Length, etc.), so fetch gets to regenerate them.
const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "expect",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

/**
 * Re-issue a captured request against a target URL, server-side (no CORS
 * headaches), and report what came back.
 */
export async function POST(req: NextRequest) {
  let payload: { binId?: string; requestId?: string; targetUrl?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { binId, requestId, targetUrl } = payload;
  if (!binId || !requestId || !targetUrl) {
    return NextResponse.json(
      { error: "binId, requestId and targetUrl are required" },
      { status: 400 }
    );
  }

  let target: URL;
  try {
    target = new URL(targetUrl);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error();
  } catch {
    return NextResponse.json(
      { error: "targetUrl must be a valid http(s) URL" },
      { status: 400 }
    );
  }

  const captured = findRequest(binId, requestId);
  if (!captured) {
    return NextResponse.json(
      { error: "Request not found (bins are in-memory and reset on restart)" },
      { status: 404 }
    );
  }

  const headers = new Headers();
  for (const [k, v] of Object.entries(captured.headers)) {
    if (!SKIP_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }

  let body: BodyInit | undefined;
  if (captured.bodyEncoding === "utf8") body = captured.body;
  else if (captured.bodyEncoding === "base64")
    body = Buffer.from(captured.body, "base64");
  const canHaveBody = !["GET", "HEAD"].includes(captured.method);

  const startedAt = Date.now();
  try {
    const res = await fetch(target, {
      method: captured.method,
      headers,
      body: canHaveBody ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });

    const text = await res.text();
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (responseHeaders[k] = v));

    return NextResponse.json({
      ok: true,
      status: res.status,
      statusText: res.statusText,
      durationMs: Date.now() - startedAt,
      headers: responseHeaders,
      body: text.slice(0, 64 * 1024),
      bodyTruncated: text.length > 64 * 1024,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? "Target did not respond within 15s"
        : err instanceof Error
          ? err.message
          : "Replay failed";
    return NextResponse.json(
      { ok: false, error: message, durationMs: Date.now() - startedAt },
      { status: 502 }
    );
  }
}
