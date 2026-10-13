# hookscope: how it actually works

This is the "explain it to future me" document. The [README](README.md) covers
*using* and *deploying* the app. This file covers *why the code is shaped the
way it is*.

## The one-paragraph version

A **bin** is a random id. Anything sent to `/api/hook/<id>/...` is captured
(method, path, headers, body…) and handed to a **store**. The store does two
things: it **saves** the capture in a per-bin list, and it **broadcasts** it on
a per-bin channel. Every browser tab looking at that bin holds open an **SSE
stream**, which is subscribed to that channel and forwards each capture to the
page as it arrives. **Replay** looks a capture up in the store and re-sends it
from the server with `fetch`.

## The big design decision: two stores behind one interface

Version 1 kept everything in a `Map` plus an `EventEmitter` in memory. That's
perfect for one long-running Node process, and **broken on Vercel**:

```
          ┌─ instance A ─┐            ┌─ instance B ─┐
 webhook ─▶ capture route │            │ stream route ◀── your browser
          │ memory Map A  │  ✗ no link │ memory Map B │
          └───────────────┘            └──────────────┘
```

On Vercel, each request may run on a different serverless instance, and
instances share no memory. The webhook lands in A's memory, while your browser's
stream lives on B and never hears about it.

The fix is a shared store that has **pub/sub**: Redis. So `lib/store/` has one
interface (`types.ts`) and two implementations:

| | `memory.ts` | `redis.ts` |
| --- | --- | --- |
| Save captures | `Map<binId, requests[]>` | `LPUSH` onto `hookscope:bin:<id>:requests` |
| Broadcast | `EventEmitter.emit(binId)` | `PUBLISH hookscope:bin:<id>` |
| Live stream listens with | `emitter.on(binId)` | `SUBSCRIBE hookscope:bin:<id>` |
| Expiry | sweep on bin creation | Redis `EXPIRE` (refreshed on each write) |
| Rate-limit counters | `Map` | `INCR` + `EXPIRE` |
| Used when | no `REDIS_URL` (local dev, single server) | `REDIS_URL` / `KV_URL` set |

`lib/store/index.ts → getStore()` picks one. It also includes a deliberate
guard: on Vercel **without** Redis it throws `StoreNotConfiguredError`, which
the routes turn into a 503 with a "connect Redis" message. The alternative is an
app that looks like it works and then silently never shows live updates. Failing
loudly is kinder.

The routes only ever call `getStore()`, so none of them know or care which
store is active. That's the point of the interface.

## Life of a webhook (Redis mode)

```
 1. POST /api/hook/abc123/stripe       (lands on instance B)
 2.   rateLimit("capture:abc123")      INCR counter, reject with 429 if over
 3.   read body bytes → utf8 or base64, truncate past MAX_BODY_KB
 4.   store.addRequest(captured)       one MULTI round trip:
        LPUSH  list   capture JSON
        LTRIM  list   keep newest MAX_REQUESTS_PER_BIN
        EXPIRE list   BIN_TTL_HOURS
        SET NX created-at, EXPIRE
        PUBLISH channel  {"type":"request","request":{…}}
 5. Redis delivers the message to every subscriber, e.g. instance A
 6. Instance A's stream route writes  "event: request\ndata: {…}\n\n"
 7. The browser's EventSource fires → React prepends the row and flashes it
```

## File-by-file

### `lib/config.ts`: every tunable

Reads env vars once, with defaults: limits, TTL, rate limits, the Redis URL,
and `allowPrivateReplay` (true in dev, false in prod). Also holds
`BIN_ID_PATTERN`, which every route uses to reject junk ids before they reach
storage (Redis key injection, giant strings, `../` games).

### `lib/types.ts`: shapes shared by server and browser

`CapturedRequest`, `BinEvent`, `ReplayResult`. The UI imports these with
`import type`, which TypeScript erases at compile time, so no server code
leaks into the browser bundle. (Version 1 duplicated the interface in the UI
for exactly this reason. `import type` makes that unnecessary.)

### `lib/store/redis.ts`: the interesting one

- **Two connections per instance, cached on `globalThis`.** One handles normal
  commands. The other is dedicated to `SUBSCRIBE`, because a Redis connection in
  subscribe mode can't run anything else. Caching on `globalThis` means warm
  serverless invocations reuse open connections instead of reconnecting every time.
- **One shared subscriber for all streams on an instance.** node-redis tracks
  listeners per channel and only sends `UNSUBSCRIBE` to Redis when the last
  listener for a channel goes away. Five tabs open on one bin means one Redis
  subscription.
- **`RESP: 2`.** node-redis v6 defaults to the newer RESP3 protocol. RESP2 is
  what every hosted Redis speaks, so it's pinned for compatibility.
- **A failed connect isn't cached.** If `connect()` rejects, the cached promise
  is cleared so the next request retries instead of failing forever.
- **`client.on("error")`** must exist. Without it, a dropped Redis connection
  emits an unhandled `error` event, which crashes the Node process.

### `lib/store/memory.ts`

The same contract with a `Map`, an `EventEmitter`, and a counter map for rate
limits. Still stored on `globalThis` so Next.js dev hot-reloads don't wipe your
bins every time you save a file.

### `lib/http.ts`: small shared route helpers

- `clientIp()`: `x-real-ip`, then `x-forwarded-for`. Vercel sets these itself.
- `rateLimit(key, limit)`: a fixed-window counter via `store.hit()`. Returns
  a ready-made 429 response, or `null` to proceed.
- `handleRouteError()`: turns "Redis not configured" into a 503 and anything
  else into a clean 500, instead of leaking stack traces.

### `lib/safe-fetch.ts`: SSRF protection for replay

On a public deployment, replay means *"server, please send a request to any URL
I type"*. Without protection, someone could type `http://169.254.169.254/` (the
cloud metadata service) or `http://10.0.0.5/admin` and use your server to reach
places they can't. That's called **SSRF**.

The defense has three layers:

1. **A blocklist** (`net.BlockList`) of loopback, private, link-local, CGNAT,
   IPv6 ULA, NAT64, multicast and reserved ranges. `BlockList` also matches
   IPv4-mapped IPv6 (`::ffff:127.0.0.1`) against the IPv4 rules.
2. **IP-literal URLs** (`http://127.0.0.1/`) are checked before fetching. The
   `URL` parser normalizes tricks like `http://2130706433/` (decimal) and
   `http://0x7f.1/` (hex) to `127.0.0.1` first, so those are caught too.
3. **Hostnames are checked inside the socket's DNS lookup.** It uses an undici
   `Agent` with a custom `lookup`, so the IP that gets validated is exactly the
   IP that gets connected to. Checking first and fetching second would be
   beaten by **DNS rebinding**, where a domain answers "public IP" to the check
   and "127.0.0.1" a millisecond later to the real connection.

This is also why the project depends on `undici` directly: Node's built-in
`fetch` *is* undici, but the `dispatcher` option needs the package's own
`Agent` class.

`redirect: "manual"` in the replay route matters too. Following redirects would
let a public URL bounce the request to an internal one.

### `app/api/hook/[binId]/[[...path]]/route.ts`: capture

- `[[...path]]` is an *optional catch-all*, so `/api/hook/abc` and
  `/api/hook/abc/any/depth?x=1` both land here.
- One `capture()` function is exported under every HTTP method name.
- **Platform headers are stripped** (`x-vercel-*`, `x-middleware-*`…).
  Vercel injects these, the sender didn't send them, and some (like OIDC
  tokens and proxy signatures) shouldn't be displayed to anyone.
- **CORS:** `Access-Control-Allow-Origin: *`, plus an `OPTIONS` preflight
  answered with 204, so bins work from browser `fetch()` too. Preflights are
  still captured, because that's what really hit the URL.
- `HEAD` and `OPTIONS` responses have no body, as HTTP requires.

### `app/api/bins/[binId]/stream/route.ts`: SSE

- Returns a `Response` wrapping a `ReadableStream` with
  `Content-Type: text/event-stream`.
- Sends `retry: 1500` first, which tells the browser how quickly to reconnect.
- **`hello` is sent only after the subscription is live.** The browser refetches
  the backlog when it receives `hello`, so any capture that lands between "page
  loaded" and "subscribed" is still picked up. That ordering closes a small race.
- **Serverless lifetime:** `maxDuration = 300` (the Vercel Hobby ceiling with
  Fluid compute). On Vercel the stream ends itself at about 280s, `EventSource`
  reconnects automatically, gets a fresh `hello`, and refetches the backlog. To
  the user it's one continuous live view.
- A `: heartbeat` comment every 20s keeps proxies from timing out idle streams.
- Cleanup (clear timers, unsubscribe, close) runs from the client `abort`, the
  stream `cancel`, and the lifetime timer, and is safe to call more than once.
  This is what keeps subscriber counts at zero after tabs close (verified
  against Redis during testing).

### `app/api/replay/route.ts`

Validates input, rate-limits per IP, looks the capture up, drops
connection-level headers (`host`, `content-length`, `x-forwarded-*`…) that
would corrupt the new request, and calls `safeFetch` with a 15s timeout. The
target's status, headers and first 64 KB of body go back to the UI.
`describeFetchError` unwraps undici's generic `"fetch failed"` into something
readable (`ECONNREFUSED`, "Blocked: … private address", timeouts).

### `app/api/bins/...`: create, list, clear

`POST /api/bins` makes a 12-character id (about 62 bits of randomness, which is
what makes "knowing the URL" safe enough as the only access control) and is
rate-limited per IP. `GET`/`DELETE …/requests` read or clear a bin. Clearing
publishes a `cleared` event, so every open tab empties at once.

### `app/b/[binId]/inspector.tsx`: the console UI

- Opens one `EventSource`. On `hello` it **merges** the backlog into state,
  deduped by id and sorted by time. A merge rather than a replace, so rows that
  streamed in while the fetch was in flight aren't lost.
- Connection badge states: `connecting`, `live`, `reconnecting` (the browser is
  retrying, e.g. after the 280s serverless rollover), `offline` (it gave up).
- The detail pane follows the newest request until you click one.
- **Copy as curl** uses POSIX single-quote escaping. Inside `'…'` nothing is
  expanded, and a literal `'` becomes `'\''`. The old version used double quotes,
  where a header containing `$HOME` or a backtick would have been executed by
  your shell when you pasted it.
- The replay target defaults to the bin itself, so one click demos the whole loop.

### `app/page.tsx` + `app/create-bin-button.tsx`

The landing page is a **server component**, so it's prerendered to static HTML
at build time (fast first paint, crawlable). Only the button is a client
component. It shows the server's error text, such as rate limits or missing
Redis.

### SEO and sharing

- `app/layout.tsx`: title, description, Open Graph and Twitter metadata.
  `metadataBase` comes from `NEXT_PUBLIC_SITE_URL` or Vercel's
  `VERCEL_PROJECT_PRODUCTION_URL`, so share cards get absolute URLs.
- `app/opengraph-image.tsx`: the link-preview card, drawn with JSX via
  `next/og` and rendered to PNG at build time.
- `app/icon.svg`: the favicon. Next serves it automatically.
- `app/robots.ts`: lets crawlers index the landing page and blocks `/b/` and
  `/api/`. Bin pages also send `noindex` (meta tag and `X-Robots-Tag`), because
  they're private scratch space.

### `next.config.ts`

Turns off the `X-Powered-By` header and adds security headers (`nosniff`,
`X-Frame-Options: DENY`, HSTS, a restrictive `Permissions-Policy`,
`Referrer-Policy`).

### Design (`app/globals.css`)

"Signal intercept console": a near-black green base, a chartreuse "phosphor"
accent, a faint CRT scanline overlay, IBM Plex Mono for data, and Instrument
Serif italics for display text. HTTP methods are color-coded the same way
everywhere. It respects `prefers-reduced-motion`, and keyboard focus gets a
visible outline.

## How it was tested

- **Cross-instance (the Vercel scenario):** two production servers (`next
  start` on :3001 and :3002) pointed at the same Redis. Browser stream on
  :3001, webhooks sent to :3002. Requests and `cleared` events arrived live.
- **SSRF:** replay to `localhost`, `127.0.0.1`, `[::ffff:127.0.0.1]`,
  `2130706433`, `169.254.169.254`, `10.0.0.5` and `file://` were all refused.
  `https://example.com` went through.
- **Limits:** the 11th bin creation in a minute returned 429. Invalid bin ids
  returned 404.
- **Cleanup:** the Redis subscriber count dropped back to 0 when streams closed.
- **Memory mode:** live stream, backlog, and replay-to-self in `npm run dev`.

## Known limitations

- **Bin ids are bearer tokens.** Anyone with the URL can view the bin. Fine for
  debugging, not for production secrets.
- **Rate limits are fixed-window**, so a burst at a window boundary can briefly
  get up to 2× through. That's acceptable for abuse prevention.
- **Body cap is 256 KB by default.** Vercel itself rejects request bodies over
  4.5 MB.
- **Each capture costs about 8 Redis commands** (rate limit + store + publish).
  Upstash's free tier covers tens of thousands of captures a month, plenty for
  personal use. A popular public instance would need a paid tier.
