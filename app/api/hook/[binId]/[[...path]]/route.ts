import { NextRequest, NextResponse } from "next/server";
import { addRequest, newRequestId, type CapturedRequest } from "@/lib/store";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024; // keep at most 1 MiB of any payload

// One handler captures every HTTP method. The [[...path]] optional catch-all
// means /api/hook/<bin>, /api/hook/<bin>/github/push, etc. all land here, so
// callers can use whatever sub-path shape their webhook config expects.
async function capture(
  req: NextRequest,
  ctx: { params: Promise<{ binId: string; path?: string[] }> }
) {
  const { binId, path } = await ctx.params;

  const url = new URL(req.url);
  const subPath = "/" + (path?.join("/") ?? "");
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (query[k] = v));

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));

  // Read the raw body as bytes; store text when it's valid UTF-8, base64
  // otherwise, and truncate anything over the cap so one giant payload
  // can't eat the process memory.
  let body = "";
  let bodyEncoding: CapturedRequest["bodyEncoding"] = "none";
  let bodyTruncated = false;
  let size = 0;

  const raw = new Uint8Array(await req.arrayBuffer());
  size = raw.byteLength;
  if (size > 0) {
    let bytes = raw;
    if (bytes.byteLength > MAX_BODY_BYTES) {
      bytes = bytes.slice(0, MAX_BODY_BYTES);
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
    path: subPath + (url.search || ""),
    query,
    headers,
    body,
    bodyEncoding,
    bodyTruncated,
    contentType: req.headers.get("content-type"),
    size,
    ip:
      req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
      req.headers.get("x-real-ip"),
    receivedAt: Date.now(),
  };

  addRequest(captured);

  return NextResponse.json(
    { ok: true, binId, requestId: captured.id },
    { status: 200 }
  );
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
