# hookscope — Webhook Inspector

A mini RequestBin: open a bin, get a temporary URL, and every HTTP request that
hits that URL is captured and streamed to your browser **live** — method, path,
query params, headers, body, size, source IP, timestamp. Any captured request
can be **replayed** (resent) to any URL with one click.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

Click **"open a new bin"**, copy the bin URL, and point anything at it:

```bash
curl -X POST http://localhost:3000/api/hook/<binId>/anything/you/like?q=1 \
  -H "content-type: application/json" \
  -d '{"event":"order.created"}'
```

The request appears in the UI the instant it lands — no refresh.

> To receive webhooks from the outside world (Stripe, GitHub, …) you still need
> a tunnel to your machine, e.g. `ngrok http 3000` or `cloudflared tunnel`, and
> then you give the provider `https://<tunnel-host>/api/hook/<binId>`.

## Why Next.js (and not Laravel)

Three reasons, all practical:

1. **One process, shared memory.** The whole trick of this tool is that the
   route which *captures* a request and the route which *streams* to the
   browser share the same in-memory store and event emitter. Node's
   long-running single process makes that free. PHP's request-per-process
   model would force Redis/database + polling or a separate websocket server
   for the same result.
2. **SSE is trivial in a route handler.** A `ReadableStream` returned from a
   Next.js route handler *is* the SSE connection. No extra packages.
3. **One language end to end** — the store types are the same shapes the React
   UI consumes.

Total dependency count: `next`, `react`, `react-dom`, `nanoid`. No database,
no Tailwind, no state library. Styling is a single hand-written CSS file.

## Architecture — the life of a webhook

```
 curl/Stripe/GitHub                 your browser
        │                                ▲
        ▼                                │ (2) SSE push, instantly
 POST /api/hook/<binId>/...              │
        │                        GET /api/bins/<binId>/stream
        ▼                                │
   [capture route] ──(1) emit──▶ [EventEmitter] 
        │                                
        ▼                                
   [in-memory Map of bins]  ◀── GET /api/bins/<binId>/requests (initial load)
        │
        └──▶ POST /api/replay ──(3) re-issued fetch──▶ any target URL
```

1. **Capture** — the hook route stores the request in the bin and emits an
   event named `bin:<binId>`.
2. **Stream** — every open SSE connection for that bin is subscribed to that
   event and forwards the captured request down the wire as an SSE `request`
   event. This is exactly the same publish/subscribe-over-SSE pattern as a
   notifications feed: EventEmitter on the server, `EventSource` in the
   browser.
3. **Replay** — the server (not the browser) re-issues the stored request with
   `fetch()`, so there are no CORS restrictions on where you can send it.

## File-by-file

### `lib/store.ts` — the entire "database"

- `Map<binId, Bin>` where a `Bin` holds an array of `CapturedRequest`s
  (newest first), plus one shared `EventEmitter`.
- Both are stashed on **`globalThis`**. That matters in dev: Next.js hot-reload
  re-evaluates modules, which would otherwise wipe the store every time you
  save a file. `globalThis` survives reloads because the *process* doesn't
  restart.
- Caps: 500 requests per bin, 200 bins, oldest evicted first — a leak guard,
  since nothing is ever persisted.
- `subscribe(binId, onRequest, onCleared)` returns an unsubscribe function —
  the SSE route calls it when the browser disconnects, so listeners never leak.
- `getOrCreateBin`: unknown bin IDs are auto-created on first touch. That way a
  hook URL keeps working even after a server restart wipes memory (the history
  is gone, but new requests are still captured).

### `app/api/hook/[binId]/[[...path]]/route.ts` — the catch-all capture route

- `[[...path]]` is an **optional catch-all** segment, so
  `/api/hook/abc`, `/api/hook/abc/github/push`, `/api/hook/abc/x?y=z` all
  resolve to this one file. Providers often demand a specific path shape —
  this accepts anything.
- One `capture()` function is exported under **every HTTP method name**
  (`export { capture as GET, capture as POST, ... }`).
- Body handling: the raw bytes are read with `arrayBuffer()`, then decoded as
  strict UTF-8 (`TextDecoder` with `fatal: true`). If decoding throws, the
  payload is binary → stored as base64 and labelled as such in the UI.
  Bodies are truncated at 1 MiB so a huge payload can't eat the process.
- Always answers `200 {ok:true}` — webhook senders see success and don't retry.

### `app/api/bins/[binId]/stream/route.ts` — the SSE endpoint

- Returns a `Response` wrapping a `ReadableStream` with
  `Content-Type: text/event-stream`.
- On connect it sends a `hello` event (the UI uses it to flip the LIVE badge),
  subscribes to the bin's emitter, and forwards each captured request as an
  SSE `request` event; a `cleared` event tells all open tabs the bin was wiped.
- A comment-line heartbeat (`: heartbeat`) every 25 s stops proxies from
  killing the idle connection.
- `req.signal`'s `abort` event fires when the browser tab closes → interval
  cleared, emitter unsubscribed, stream closed. That cleanup is what keeps
  listener counts flat no matter how many tabs open and close.

### `app/api/bins/route.ts` + `app/api/bins/[binId]/requests/route.ts`

Plain JSON endpoints: create a bin (`POST /api/bins`), fetch the backlog on
page load (`GET .../requests`), wipe history (`DELETE .../requests`).

### `app/api/replay/route.ts` — resend a captured request

- Body: `{ binId, requestId, targetUrl }`. Looks the capture up in the store
  and re-issues it server-side with `fetch()`.
- **Header filtering** is the subtle part: `host`, `content-length`,
  `connection`, `accept-encoding`, `x-forwarded-*` etc. describe the *original
  connection*, not the request. Forwarding them verbatim would send a wrong
  Host header or a stale Content-Length, so they're dropped and `fetch`
  regenerates them for the new target.
- 15-second timeout via `AbortSignal.timeout`, redirects not followed
  (`redirect: "manual"` — you want to see the 3xx, not chase it), and the
  target's status/headers/body (first 64 KB) are reported back to the UI.

### `app/b/[binId]/inspector.tsx` — the console UI (client component)

State machine is small: `requests[]`, `selectedId`, `connected`, `freshIds`.

- On mount: one `fetch` for the backlog, then an `EventSource` for the live
  stream. New arrivals are prepended (deduped by id — a request can arrive
  via both the backlog fetch and SSE in a race). `freshIds` drives the brief
  highlight flash on new rows.
- If you haven't clicked a row, the detail pane follows the newest request
  ("follow mode"); once you select one, it stays put.
- Detail pane: query params table, headers table, body (JSON is
  pretty-printed via parse→re-stringify; binary shows base64), a **copy as
  curl** block that reconstructs the request as a runnable command, and the
  **replay** panel.
- The replay target defaults to the bin's own URL — hit replay and you watch
  the copy arrive in the list a beat later, which is the whole loop in one
  click.
- The hook URL is built from `window.location.origin` in the browser, because
  the server doesn't reliably know what host/port you're reaching it on.

### `app/page.tsx` — landing

One button: `POST /api/bins` → redirect to `/b/<id>`.

### Design (`app/globals.css`)

"Signal intercept console": near-black green-tinted background, phosphor
chartreuse accent, faint CRT scanline overlay (a `position: fixed`
repeating-gradient layer), IBM Plex Mono for all data, Instrument Serif
italics for display moments (the landing headline, empty states). HTTP
methods are color-coded (GET green, POST amber, PUT blue, PATCH violet,
DELETE red) consistently in the list and detail views. Loaded via
`next/font` so the fonts are self-hosted at build time.

## Deliberate limitations

- **In-memory only.** Restart = empty bins. That's a feature for a throwaway
  debugging tool, but don't expect history to survive.
- **Single process.** The store/emitter pattern assumes one Node process. It
  would not work on serverless (Vercel) or a multi-worker deploy without
  swapping the store for Redis pub/sub. Run it with `npm run dev` or
  `npm run build && npm start` on one machine.
- **No auth.** Anyone who knows a bin id can view it. Bin ids are 10 random
  characters (~52 bits), which is plenty for a local/dev tool.
- **Replay is open.** The replay endpoint will send to any http(s) URL you
  give it — again fine locally, but it's an SSRF vector if you ever host this
  publicly, so don't.
