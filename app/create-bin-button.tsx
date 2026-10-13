"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function CreateBinButton() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createBin() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/bins", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Server responded ${res.status}`);
      router.push(`/b/${data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setCreating(false);
    }
  }

  return (
    <div className="landing-actions">
      <button className="btn-primary" onClick={createBin} disabled={creating}>
        {creating ? "opening…" : "open a new bin →"}
      </button>
      {error && (
        <span className="landing-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
