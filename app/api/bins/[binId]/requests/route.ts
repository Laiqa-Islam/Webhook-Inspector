import { NextRequest, NextResponse } from "next/server";
import { clearBin, getOrCreateBin } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Initial page load: everything captured so far (newest first). */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ binId: string }> }
) {
  const { binId } = await ctx.params;
  const bin = getOrCreateBin(binId);
  return NextResponse.json({
    id: bin.id,
    createdAt: bin.createdAt,
    requests: bin.requests,
  });
}

/** Wipe the bin's history. */
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ binId: string }> }
) {
  const { binId } = await ctx.params;
  clearBin(binId);
  return NextResponse.json({ ok: true });
}
