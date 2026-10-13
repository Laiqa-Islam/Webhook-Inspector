"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function Landing() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createBin() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/bins", { method: "POST" });
      if (!res.ok) throw new Error(`Server said ${res.status}`);
      const { id } = await res.json();
      router.push(`/b/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setCreating(false);
    }
  }

  return (
    <main className="landing">
      <header className="landing-head">
        <div className="wordmark">
          hook<em>scope</em>
        </div>
        <div className="wordmark-sub">webhook inspector</div>
      </header>

      <section className="landing-main">
        <p className="landing-kicker">/// signal intercept console</p>
        <h1 className="landing-title">
          Catch every webhook.
          <br />
          <em>Inspect it. Replay it.</em>
        </h1>
        <p className="landing-sub">
          Open a bin and you get a temporary URL. Point any webhook, curl, or
          misbehaving integration at it — every request lands here live, with
          headers, body and timing laid bare. One click resends it anywhere.
        </p>
        <div className="landing-actions">
          <button className="btn-primary" onClick={createBin} disabled={creating}>
            {creating ? "opening…" : "open a new bin →"}
          </button>
          {error && <span style={{ color: "var(--m-delete)" }}>{error}</span>}
        </div>
      </section>

      <footer className="landing-foot">
        <span>in-memory · nothing persisted</span>
        <span>any method, any path</span>
        <span>live over server-sent events</span>
      </footer>
    </main>
  );
}
