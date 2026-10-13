import { NextRequest, NextResponse } from "next/server";
import { customAlphabet } from "nanoid";
import { config } from "@/lib/config";
import { clientIp, handleRouteError, rateLimit } from "@/lib/http";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 12 chars from a 36-char alphabet ≈ 62 bits: unguessable enough that the
// bin id can double as the only access control.
const newBinId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

export async function POST(req: NextRequest) {
  try {
    const limited = await rateLimit(
      `bins:${clientIp(req.headers) ?? "unknown"}`,
      config.rateLimit.binsPerMinute
    );
    if (limited) return limited;

    const bin = await getStore().createBin(newBinId());
    return NextResponse.json(bin);
  } catch (err) {
    return handleRouteError(err);
  }
}
