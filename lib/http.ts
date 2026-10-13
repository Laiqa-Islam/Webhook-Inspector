import { NextResponse } from "next/server";
import { BIN_ID_PATTERN } from "@/lib/config";
import { getStore, StoreNotConfiguredError } from "@/lib/store";

/** Best-effort client IP. Vercel sets x-real-ip / x-forwarded-for itself. */
export function clientIp(headers: Headers): string | null {
  return (
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    null
  );
}

export function isValidBinId(id: string): boolean {
  return BIN_ID_PATTERN.test(id);
}

export function jsonError(status: number, error: string, init?: ResponseInit) {
  return NextResponse.json({ error }, { ...init, status });
}

/**
 * Fixed-window rate limit. Returns a 429 response when over the limit, or
 * null when the caller may proceed.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds = 60
): Promise<NextResponse | null> {
  const count = await getStore().hit(key, windowSeconds);
  if (count <= limit) return null;
  return jsonError(429, `Rate limit exceeded: ${limit} per ${windowSeconds}s`, {
    headers: { "Retry-After": String(windowSeconds) },
  });
}

/** Turns storage failures into clean JSON errors instead of stack traces. */
export function handleRouteError(err: unknown) {
  if (err instanceof StoreNotConfiguredError) {
    return jsonError(503, err.message);
  }
  console.error(err);
  return jsonError(500, "Internal error, storage may be unreachable");
}
