import { NextResponse } from "next/server";
import { createBin } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Create a fresh bin and hand back its id. */
export async function POST() {
  const bin = createBin();
  return NextResponse.json({ id: bin.id, createdAt: bin.createdAt });
}
