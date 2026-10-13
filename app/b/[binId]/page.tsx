import Inspector from "./inspector";

export default async function BinPage({
  params,
}: {
  params: Promise<{ binId: string }>;
}) {
  const { binId } = await params;
  return <Inspector binId={binId} />;
}
