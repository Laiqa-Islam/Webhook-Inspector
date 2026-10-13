"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

// Mirrors CapturedRequest in lib/store.ts — kept as a separate type because
// this file ships to the browser and must not import the server store.
interface CapturedRequest {
  id: string;
  binId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: "utf8" | "base64" | "none";
  bodyTruncated: boolean;
  contentType: string | null;
  size: number;
  ip: string | null;
  receivedAt: number;
}

interface ReplayResult {
  ok: boolean;
  status?: number;
  statusText?: string;
  durationMs: number;
  body?: string;
  error?: string;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

function formatSize(bytes: number) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function prettyBody(req: CapturedRequest): string {
  if (req.bodyEncoding === "base64") return req.body;
  try {
    return JSON.stringify(JSON.parse(req.body), null, 2);
  } catch {
    return req.body;
  }
}

function buildCurl(hookUrl: string, req: CapturedRequest): string {
  const parts = [`curl -X ${req.method} "${hookUrl}${req.path}"`];
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "content-length", "connection"].includes(k)) continue;
    parts.push(`  -H "${k}: ${v.replace(/"/g, '\\"')}"`);
  }
  if (req.bodyEncoding === "utf8" && req.body) {
    parts.push(`  --data '${req.body.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(" \\\n");
}

function CopyButton({
  text,
  className = "chip-btn",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={className}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "copied ✓" : "copy"}
    </button>
  );
}

export default function Inspector({ binId }: { binId: string }) {
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [hookUrl, setHookUrl] = useState("");
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());

  // The absolute hook URL depends on where the app is served from, which the
  // server doesn't reliably know — derive it in the browser.
  useEffect(() => {
    setHookUrl(`${window.location.origin}/api/hook/${binId}`);
  }, [binId]);

  // Initial backlog + live SSE stream.
  useEffect(() => {
    let cancelled = false;

    fetch(`/api/bins/${binId}/requests`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setRequests(data.requests ?? []);
      })
      .catch(() => {});

    const es = new EventSource(`/api/bins/${binId}/stream`);
    es.addEventListener("hello", () => setConnected(true));
    es.addEventListener("request", (ev) => {
      const req: CapturedRequest = JSON.parse((ev as MessageEvent).data);
      setRequests((prev) =>
        prev.some((r) => r.id === req.id) ? prev : [req, ...prev]
      );
      setFreshIds((prev) => new Set(prev).add(req.id));
      setTimeout(() => {
        setFreshIds((prev) => {
          const next = new Set(prev);
          next.delete(req.id);
          return next;
        });
      }, 1200);
    });
    es.addEventListener("cleared", () => {
      setRequests([]);
      setSelectedId(null);
    });
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);

    return () => {
      cancelled = true;
      es.close();
    };
  }, [binId]);

  const clearAll = useCallback(async () => {
    await fetch(`/api/bins/${binId}/requests`, { method: "DELETE" });
    // The SSE "cleared" event resets state; this is just a fallback.
    setRequests([]);
    setSelectedId(null);
  }, [binId]);

  const selected =
    requests.find((r) => r.id === selectedId) ?? requests[0] ?? null;

  return (
    <div className="console">
      <header className="console-bar">
        <Link href="/" className="wordmark">
          hook<em>scope</em>
        </Link>

        <div className="bin-url">
          <code title={hookUrl}>{hookUrl || "…"}</code>
          <CopyButton text={hookUrl} />
        </div>

        <div className={`live ${connected ? "on" : ""}`}>
          <span className="live-dot" />
          {connected ? "live" : "offline"}
        </div>

        <div className="bar-actions">
          <button className="ghost-btn" onClick={clearAll}>
            clear
          </button>
          <Link href="/" className="ghost-btn" style={{ display: "inline-block" }}>
            new bin
          </Link>
        </div>
      </header>

      <div className="console-body">
        <aside className="req-list">
          <div className="req-list-head">
            intercepted — {requests.length}
            {requests.length === 1 ? " request" : " requests"}
          </div>
          {requests.map((r) => (
            <button
              key={r.id}
              className={`req-row ${selected?.id === r.id ? "selected" : ""} ${
                freshIds.has(r.id) ? "fresh" : ""
              }`}
              onClick={() => setSelectedId(r.id)}
            >
              <span className={`method ${r.method}`}>{r.method}</span>
              <span className="path">{r.path}</span>
              <span className="meta">
                {formatTime(r.receivedAt)} · {formatSize(r.size)}
              </span>
            </button>
          ))}
          {requests.length === 0 && (
            <div className="empty" style={{ minHeight: 180 }}>
              <div style={{ color: "var(--ink-faint)", fontSize: 12 }}>
                nothing intercepted yet
              </div>
            </div>
          )}
        </aside>

        <main className="detail">
          {selected ? (
            <RequestDetail key={selected.id} req={selected} hookUrl={hookUrl} />
          ) : (
            <div className="empty">
              <div className="empty-title">
                Waiting for signals<span className="blink">_</span>
              </div>
              <p style={{ color: "var(--ink-dim)", maxWidth: "46ch" }}>
                Send anything to your bin URL — any method, any path, any
                payload — and it appears here the moment it arrives.
              </p>
              {hookUrl && (
                <div className="curl-hint">
                  <span className="prompt">$ </span>
                  <span className="cmd">
                    {`curl -X POST ${hookUrl}/orders \\\n      -H "content-type: application/json" \\\n      -d '{"event":"order.created","amount":4900}'`}
                  </span>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function RequestDetail({
  req,
  hookUrl,
}: {
  req: CapturedRequest;
  hookUrl: string;
}) {
  const [target, setTarget] = useState("");
  const [replaying, setReplaying] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const targetTouched = useRef(false);

  // Default the replay target to the bin itself — replaying then visibly
  // lands a new capture, which demos the whole loop nicely.
  useEffect(() => {
    if (!targetTouched.current && hookUrl) setTarget(hookUrl + req.path);
  }, [hookUrl, req.path]);

  async function replay() {
    setReplaying(true);
    setResult(null);
    try {
      const res = await fetch("/api/replay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          binId: req.binId,
          requestId: req.id,
          targetUrl: target,
        }),
      });
      setResult(await res.json());
    } catch (err) {
      setResult({
        ok: false,
        durationMs: 0,
        error: err instanceof Error ? err.message : "Replay failed",
      });
    } finally {
      setReplaying(false);
    }
  }

  const queryEntries = Object.entries(req.query);
  const headerEntries = Object.entries(req.headers);
  const body = prettyBody(req);

  return (
    <>
      <div className="detail-head">
        <span className={`method ${req.method}`}>{req.method}</span>
        <span className="path">{req.path}</span>
      </div>
      <div className="detail-sub">
        {new Date(req.receivedAt).toLocaleString()} · {formatSize(req.size)}
        {req.ip ? ` · from ${req.ip}` : ""} · id {req.id}
      </div>

      <section className="section">
        <div className="section-title">
          <span>replay</span>
        </div>
        <div className="replay-row">
          <input
            value={target}
            onChange={(e) => {
              targetTouched.current = true;
              setTarget(e.target.value);
            }}
            placeholder="https://target-to-resend-to.example/webhook"
            spellCheck={false}
          />
          <button
            className="replay-btn"
            onClick={replay}
            disabled={replaying || !target}
          >
            {replaying ? "sending…" : "⟳ replay"}
          </button>
        </div>
        {result && (
          <div className="replay-result">
            {result.ok ? (
              <span
                className={
                  (result.status ?? 0) < 300
                    ? "status-ok"
                    : (result.status ?? 0) < 500
                      ? "status-warn"
                      : "status-err"
                }
              >
                {result.status} {result.statusText}
              </span>
            ) : (
              <span className="status-err">✕ {result.error}</span>
            )}
            <span style={{ color: "var(--ink-faint)" }}>
              {" "}
              · {result.durationMs}ms
            </span>
            {result.ok && result.body && <pre>{result.body}</pre>}
          </div>
        )}
      </section>

      {queryEntries.length > 0 && (
        <section className="section">
          <div className="section-title">
            <span>query params</span>
            <span className="count">{queryEntries.length}</span>
          </div>
          <table className="kv-table">
            <tbody>
              {queryEntries.map(([k, v]) => (
                <tr key={k}>
                  <td className="k">{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="section">
        <div className="section-title">
          <span>headers</span>
          <span className="count">{headerEntries.length}</span>
        </div>
        <table className="kv-table">
          <tbody>
            {headerEntries.map(([k, v]) => (
              <tr key={k}>
                <td className="k">{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="section">
        <div className="section-title">
          <span>body</span>
          <span className="count">
            {req.bodyEncoding === "none"
              ? "empty"
              : `${formatSize(req.size)}${
                  req.bodyEncoding === "base64" ? " · binary (base64)" : ""
                }${req.bodyTruncated ? " · truncated to 1 MiB" : ""}`}
          </span>
        </div>
        {req.bodyEncoding === "none" ? (
          <div className="note">This request had no body.</div>
        ) : (
          <div className="body-block">
            <CopyButton text={body} className="copy-float" />
            <pre>{body}</pre>
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-title">
          <span>copy as curl</span>
        </div>
        <div className="body-block">
          <CopyButton text={buildCurl(hookUrl, req)} className="copy-float" />
          <pre>{buildCurl(hookUrl, req)}</pre>
        </div>
      </section>
    </>
  );
}
