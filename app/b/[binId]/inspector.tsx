"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CapturedRequest, ReplayResult } from "@/lib/types";

type LinkState = "connecting" | "live" | "reconnecting" | "error";

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

/** POSIX single-quote escaping: nothing inside '…' is expanded by the shell. */
function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const CURL_SKIP = new Set(["host", "content-length", "connection", "accept-encoding"]);

function buildCurl(hookUrl: string, req: CapturedRequest): string {
  const parts = [`curl -X ${req.method} ${shellQuote(hookUrl + req.path)}`];
  for (const [k, v] of Object.entries(req.headers)) {
    if (CURL_SKIP.has(k) || k.startsWith("x-forwarded-")) continue;
    parts.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  }
  if (req.bodyEncoding === "utf8" && req.body) {
    parts.push(`  --data-raw ${shellQuote(req.body)}`);
  }
  return parts.join(" \\\n");
}

/** Merge two newest-first lists, deduping by id. */
function mergeRequests(a: CapturedRequest[], b: CapturedRequest[]) {
  const seen = new Set<string>();
  return [...a, ...b]
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((x, y) => y.receivedAt - x.receivedAt);
}

function CopyButton({ text, className = "chip-btn" }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked (insecure context / permissions) */
        }
      }}
    >
      {copied ? "copied ✓" : "copy"}
    </button>
  );
}

export default function Inspector({
  binId,
  retentionHours,
  maxRequests,
}: {
  binId: string;
  retentionHours: number;
  maxRequests: number;
}) {
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkState, setLinkState] = useState<LinkState>("connecting");
  const [hookUrl, setHookUrl] = useState("");
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());

  // The public hook URL depends on the host the app is reached through
  // (localhost, a Vercel domain, a tunnel), so derive it in the browser.
  useEffect(() => {
    setHookUrl(`${window.location.origin}/api/hook/${binId}`);
  }, [binId]);

  useEffect(() => {
    let cancelled = false;

    const loadBacklog = () =>
      fetch(`/api/bins/${binId}/requests`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled && data?.requests) {
            setRequests((prev) => mergeRequests(data.requests, prev));
          }
        })
        .catch(() => {});

    const es = new EventSource(`/api/bins/${binId}/stream`);

    // "hello" arrives on the first connect and after every reconnect (the
    // server ends streams periodically on serverless hosts). Refetching the
    // backlog then covers anything that arrived while we were disconnected.
    es.addEventListener("hello", () => {
      setLinkState("live");
      loadBacklog();
    });

    es.addEventListener("request", (ev) => {
      const req: CapturedRequest = JSON.parse((ev as MessageEvent).data);
      setRequests((prev) =>
        prev.some((r) => r.id === req.id)
          ? prev
          : [req, ...prev].slice(0, maxRequests)
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

    es.onerror = () => {
      // CONNECTING means the browser is already retrying; CLOSED means it gave
      // up (e.g. the server returned a non-SSE error response).
      setLinkState(es.readyState === EventSource.CLOSED ? "error" : "reconnecting");
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [binId, maxRequests]);

  const clearAll = useCallback(async () => {
    await fetch(`/api/bins/${binId}/requests`, { method: "DELETE" }).catch(() => {});
    setRequests([]);
    setSelectedId(null);
  }, [binId]);

  const selected = requests.find((r) => r.id === selectedId) ?? requests[0] ?? null;

  const linkLabel = {
    connecting: "connecting",
    live: "live",
    reconnecting: "reconnecting",
    error: "offline",
  }[linkState];

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

        <div className={`live ${linkState === "live" ? "on" : ""}`} aria-live="polite">
          <span className="live-dot" />
          {linkLabel}
        </div>

        <div className="bar-actions">
          <button className="ghost-btn" onClick={clearAll}>
            clear
          </button>
          <Link href="/" className="ghost-btn">
            new bin
          </Link>
        </div>
      </header>

      <div className="console-body">
        <aside className="req-list" aria-label="Captured requests">
          <div className="req-list-head">
            <span>
              intercepted · {requests.length}
              {requests.length === 1 ? " request" : " requests"}
            </span>
            <span className="req-list-retention">
              keeps last {maxRequests} · {retentionHours}h idle expiry
            </span>
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
          {requests.length === 0 && <div className="req-list-empty">nothing intercepted yet</div>}
        </aside>

        <main className="detail">
          {selected ? (
            <RequestDetail key={selected.id} req={selected} hookUrl={hookUrl} />
          ) : (
            <div className="empty">
              <div className="empty-title">
                Waiting for signals<span className="blink">_</span>
              </div>
              <p className="empty-sub">
                Send anything to your bin URL (any method, any path, any
                payload) and it appears here the moment it arrives.
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

function RequestDetail({ req, hookUrl }: { req: CapturedRequest; hookUrl: string }) {
  const [target, setTarget] = useState("");
  const [replaying, setReplaying] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const targetTouched = useRef(false);

  // Default the replay target to the bin itself: replaying then visibly lands
  // a fresh capture, which demos the whole loop in one click.
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
        body: JSON.stringify({ binId: req.binId, requestId: req.id, targetUrl: target }),
      });
      const data = await res.json();
      setResult(
        "ok" in data ? data : { ok: false, durationMs: 0, error: data.error ?? `HTTP ${res.status}` }
      );
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
  const curl = buildCurl(hookUrl, req);
  const status = result?.status ?? 0;

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
        <form
          className="replay-row"
          onSubmit={(e) => {
            e.preventDefault();
            replay();
          }}
        >
          <input
            value={target}
            onChange={(e) => {
              targetTouched.current = true;
              setTarget(e.target.value);
            }}
            placeholder="https://your-app.example/webhook"
            aria-label="Replay target URL"
            spellCheck={false}
            type="url"
          />
          <button className="replay-btn" type="submit" disabled={replaying || !target}>
            {replaying ? "sending…" : "⟳ replay"}
          </button>
        </form>
        {result && (
          <div className="replay-result" role="status">
            {result.ok ? (
              <span className={status < 300 ? "status-ok" : status < 500 ? "status-warn" : "status-err"}>
                {result.status} {result.statusText}
              </span>
            ) : (
              <span className="status-err">✕ {result.error}</span>
            )}
            <span className="muted"> · {result.durationMs}ms</span>
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
              : `${formatSize(req.size)}${req.bodyEncoding === "base64" ? " · binary (base64)" : ""}${
                  req.bodyTruncated ? " · truncated" : ""
                }`}
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
          <CopyButton text={curl} className="copy-float" />
          <pre>{curl}</pre>
        </div>
      </section>
    </>
  );
}
