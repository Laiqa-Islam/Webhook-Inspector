import { NextRequest, NextResponse } from "next/server";
import { handleRouteError, isValidBinId, jsonError } from "@/lib/http";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ binId: string }> };

/** Everything captured so far, newest first. Fetched on page load and on every stream (re)connect. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { binId } = await ctx.params;
  if (!isValidBinId(binId)) return jsonError(404, "Unknown bin");
  try {
    const bin = await getStore().getBin(binId);
    return NextResponse.json({ id: binId, ...bin });
  } catch (err) {
    return handleRouteError(err);
  }
}

/** Wipe the bin's history. Every open tab hears about it over the stream. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { binId } = await ctx.params;
  if (!isValidBinId(binId)) return jsonError(404, "Unknown bin");
  try {
    await getStore().clearBin(binId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
