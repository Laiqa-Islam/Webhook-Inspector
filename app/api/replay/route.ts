import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { clientIp, handleRouteError, isValidBinId, jsonError, rateLimit } from "@/lib/http";
import { describeFetchError, safeFetch } from "@/lib/safe-fetch";
import { getStore } from "@/lib/store";
import type { ReplayResult } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RESPONSE_PREVIEW_CHARS = 64 * 1024;

// Headers that describe the original connection rather than the request
// itself. Forwarding them would corrupt the replay (wrong Host, stale
// Content-Length), so fetch regenerates them for the new target.
const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "expect",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

/**
 * Re-issue a captured request against a target URL, server-side (so no CORS
 * restrictions), and report what came back.
 */
export async function POST(req: NextRequest) {
  let payload: { binId?: string; requestId?: string; targetUrl?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const { binId, requestId, targetUrl } = payload;
  if (!binId || !requestId || !targetUrl || !isValidBinId(binId)) {
    return jsonError(400, "binId, requestId and targetUrl are required");
  }

  let target: URL;
  try {
    target = new URL(targetUrl);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error();
  } catch {
    return jsonError(400, "targetUrl must be a valid http(s) URL");
  }

  let captured;
  try {
    const limited = await rateLimit(
      `replay:${clientIp(req.headers) ?? "unknown"}`,
      config.rateLimit.replayPerMinute
    );
    if (limited) return limited;
    captured = await getStore().findRequest(binId, requestId);
  } catch (err) {
    return handleRouteError(err);
  }
  if (!captured) {
    return jsonError(404, "Request not found, it may have expired or been cleared");
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(captured.headers)) {
    if (!SKIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }

  let body: string | Buffer | undefined;
  if (!["GET", "HEAD"].includes(captured.method)) {
    if (captured.bodyEncoding === "utf8") body = captured.body;
    else if (captured.bodyEncoding === "base64") body = Buffer.from(captured.body, "base64");
  }

  const startedAt = Date.now();
  try {
    const res = await safeFetch(
      target,
      {
        method: captured.method,
        headers,
        body,
        redirect: "manual", // show the 3xx instead of silently following it
        signal: AbortSignal.timeout(15_000),
      },
      { allowPrivate: config.allowPrivateReplay }
    );

    const text = await res.text();
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (responseHeaders[k] = v));

    return NextResponse.json({
      ok: true,
      status: res.status,
      statusText: res.statusText,
      durationMs: Date.now() - startedAt,
      headers: responseHeaders,
      body: text.slice(0, RESPONSE_PREVIEW_CHARS),
      bodyTruncated: text.length > RESPONSE_PREVIEW_CHARS,
    } satisfies ReplayResult);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: describeFetchError(err), durationMs: Date.now() - startedAt } satisfies ReplayResult,
      { status: 502 }
    );
  }
}
