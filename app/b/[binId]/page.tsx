import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BIN_ID_PATTERN, config } from "@/lib/config";
import Inspector from "./inspector";

// Bin pages are private scratch space: keep them out of search engines.
export const metadata: Metadata = {
  title: "bin · hookscope",
  robots: { index: false, follow: false },
};

export default async function BinPage({
  params,
}: {
  params: Promise<{ binId: string }>;
}) {
  const { binId } = await params;
  if (!BIN_ID_PATTERN.test(binId)) notFound();

  return (
    <Inspector
      binId={binId}
      retentionHours={config.binTtlHours}
      maxRequests={config.maxRequestsPerBin}
    />
  );
}
