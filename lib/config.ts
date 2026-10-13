// All tunables in one place. Every value can be overridden with an env var,
// see .env.example for the full list.

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

export const config = {
  /** Redis connection string. Vercel's Redis integrations set one of these. */
  redisUrl: process.env.REDIS_URL || process.env.KV_URL || "",
  /** Running on Vercel (or any serverless host) means memory storage can't work. */
  onVercel: Boolean(process.env.VERCEL),

  maxRequestsPerBin: intEnv("MAX_REQUESTS_PER_BIN", 200),
  maxBodyBytes: intEnv("MAX_BODY_KB", 256) * 1024,
  binTtlHours: intEnv("BIN_TTL_HOURS", 24),

  rateLimit: {
    /** Captures accepted per bin per minute. */
    capturePerMinute: intEnv("RATE_LIMIT_CAPTURE_PER_MIN", 120),
    /** Replays per client IP per minute. */
    replayPerMinute: intEnv("RATE_LIMIT_REPLAY_PER_MIN", 30),
    /** New bins per client IP per minute. */
    binsPerMinute: intEnv("RATE_LIMIT_BINS_PER_MIN", 10),
  },

  /**
   * Allow replaying to localhost / private networks. On in development so the
   * "replay to the bin itself" default works on localhost; off in production,
   * where it would let anyone use the server to probe internal networks.
   */
  allowPrivateReplay: boolEnv(
    "ALLOW_PRIVATE_REPLAY",
    process.env.NODE_ENV !== "production"
  ),
};

export const BIN_ID_PATTERN = /^[a-z0-9]{6,32}$/;
