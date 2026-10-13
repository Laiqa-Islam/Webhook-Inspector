import { NextRequest, NextResponse } from "next/server";
import { customAlphabet } from "nanoid";
import { config } from "@/lib/config";
import { clientIp, handleRouteError, isValidBinId, rateLimit } from "@/lib/http";
import { getStore } from "@/lib/store";
import type { CapturedRequest } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const newRequestId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 14);

// Headers injected by the hosting platform rather than sent by the caller.
// Hiding them keeps the inspector honest about what the sender sent, and some
// (e.g. x-vercel-oidc-token, proxy signatures) are not meant to be shown.
const PLATFORM_HEADER = /^(x-vercel-|x-middleware-|x-invoke-|x-nextjs-|x-matched-path$)/;

// Webhook senders are servers and don't care about CORS, but people also test
// from browser code (fetch() in a devtools console, a frontend in progress).
// Permissive CORS lets those requests through instead of failing preflight.
function corsHeaders(req: NextRequest): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
    "Access-Control-Allow-Headers":
      req.headers.get("access-control-request-headers") ?? "*",
    "Access-Control-Max-Age": "86400",
  };
}

// One handler for every method. The [[...path]] optional catch-all means
// /api/hook/<bin>, /api/hook/<bin>/github/push, etc. all land here, so callers
// can use whatever sub-path shape their webhook config expects.
async function capture(
  req: NextRequest,
  ctx: { params: Promise<{ binId: string; path?: string[] }> }
) {
  const { binId, path } = await ctx.params;
  const cors = corsHeaders(req);

  if (!isValidBinId(binId)) {
    return NextResponse.json({ error: "Unknown bin" }, { status: 404, headers: cors });
  }

  try {
    const limited = await rateLimit(`capture:${binId}`, config.rateLimit.capturePerMinute);
    if (limited) {
      for (const [k, v] of Object.entries(cors)) limited.headers.set(k, v);
      return limited;
    }

    const url = new URL(req.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (!PLATFORM_HEADER.test(k)) headers[k] = v;
    });

    // Read raw bytes; keep text when it's valid UTF-8, base64 otherwise, and
    // truncate past the cap so one giant payload can't blow up storage.
    let body = "";
    let bodyEncoding: CapturedRequest["bodyEncoding"] = "none";
    let bodyTruncated = false;
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > 0) {
      let bytes = raw;
      if (bytes.byteLength > config.maxBodyBytes) {
        bytes = bytes.slice(0, config.maxBodyBytes);
        bodyTruncated = true;
      }
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        bodyEncoding = "utf8";
      } catch {
        body = Buffer.from(bytes).toString("base64");
        bodyEncoding = "base64";
      }
    }

    const captured: CapturedRequest = {
      id: newRequestId(),
      binId,
      method: req.method,
      path: "/" + (path?.join("/") ?? "") + url.search,
      query,
      headers,
      body,
      bodyEncoding,
      bodyTruncated,
      contentType: req.headers.get("content-type"),
      size: raw.byteLength,
      ip: clientIp(req.headers),
      receivedAt: Date.now(),
    };

    await getStore().addRequest(captured);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (req.method === "HEAD") {
      return new Response(null, { status: 200, headers: cors });
    }
    return NextResponse.json(
      { ok: true, binId, requestId: captured.id },
      { status: 200, headers: cors }
    );
  } catch (err) {
    const res = handleRouteError(err);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
}

export {
  capture as GET,
  capture as POST,
  capture as PUT,
  capture as PATCH,
  capture as DELETE,
  capture as HEAD,
  capture as OPTIONS,
};
