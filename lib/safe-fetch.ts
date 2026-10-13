import { lookup, type LookupAddress } from "dns";
import { BlockList, isIP } from "net";
import { Agent, fetch, type RequestInit } from "undici";

// Replay makes the server send a request to a URL the visitor chooses, which
// on a public deployment is a classic SSRF hole: point it at 127.0.0.1, the
// cloud metadata endpoint (169.254.169.254) or a private network and the
// server would go and fetch it. This module blocks those destinations.
//
// The check runs inside the socket's DNS lookup, not before the fetch, so the
// address that gets validated is exactly the one that gets connected to. A
// hostname that resolves to a public IP at check time and a private one at
// connect time (DNS rebinding) is therefore still caught.

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 can reach IPv4 internals
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast
blocked.addSubnet("2001:db8::", 32, "ipv6");

/** True for loopback, private, link-local and other non-public addresses. */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return blocked.check(ip, "ipv4");
  // BlockList also matches IPv4-mapped IPv6 (::ffff:127.0.0.1) against the IPv4 rules.
  if (version === 6) return blocked.check(ip, "ipv6");
  return true;
}

class BlockedDestinationError extends Error {
  code = "EBLOCKED";
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

function guardedLookup(
  hostname: string,
  options: { all?: boolean } | number | LookupCallback,
  maybeCallback?: LookupCallback
) {
  const callback = (typeof options === "function" ? options : maybeCallback)!;
  const wantAll = typeof options === "object" && options?.all === true;

  lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) {
      return callback(
        new BlockedDestinationError(
          `${hostname} resolves to ${bad.address}, a private or internal address`
        ),
        []
      );
    }
    if (wantAll) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup as never } });

/**
 * fetch() that refuses to connect to non-public addresses unless
 * `allowPrivate` is set. Throws BlockedDestinationError for blocked targets.
 */
export async function safeFetch(
  url: URL,
  init: RequestInit,
  { allowPrivate }: { allowPrivate: boolean }
) {
  if (!allowPrivate) {
    // IP-literal hosts never hit DNS, so the lookup hook wouldn't see them.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isBlockedAddress(host)) {
      throw new BlockedDestinationError(
        `${host} is a private or internal address`
      );
    }
  }
  return fetch(url, allowPrivate ? init : { ...init, dispatcher: guardedAgent });
}

/** Human-readable message out of undici's nested "fetch failed" errors. */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return "Replay failed";
  if (err.name === "TimeoutError") return "Target did not respond within 15s";
  if (err instanceof BlockedDestinationError) {
    return `Blocked: ${err.message}. Replaying to private networks is disabled on this server.`;
  }
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof BlockedDestinationError) {
    return `Blocked: ${cause.message}. Replaying to private networks is disabled on this server.`;
  }
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code ? `${code}: ${cause.message}` : cause.message;
  }
  return err.message;
}
