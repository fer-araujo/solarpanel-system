import type { KeyValueStore } from "../storage/kv";
import { RateLimitExceededError } from "./rate-limiter";

/**
 * The SolaX call budget shared by every server instance.
 *
 * The in-memory RateLimiter only sees its own instance. On Vercel several
 * instances can run at once, and the local dev server uses the same account,
 * so each believed it had the whole budget and together they tripped 10406.
 * The minute counter and the 10406 backoff therefore live in Upstash.
 *
 * Fails OPEN: if Upstash is unreachable the local limiter still guards the
 * quota, and a dashboard that cannot load is worse than one less safety net.
 */

const BACKOFF_KEY = "rl:backoff";
const MINUTE_MS = 60_000;

export class SharedBudget {
  constructor(
    private readonly store: KeyValueStore,
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  async take(): Promise<void> {
    const now = this.now();
    const minute = Math.floor(now / MINUTE_MS);

    let backoffUntil: number | null;
    let count: number;
    try {
      [backoffUntil, count] = await Promise.all([
        this.store.get<number>(BACKOFF_KEY),
        // A little over a minute, so the key outlives its own window.
        this.store.incr(`rl:min:${minute}`, MINUTE_MS + 5_000),
      ]);
    } catch {
      return;
    }

    if (backoffUntil !== null && backoffUntil > now) {
      throw new RateLimitExceededError("minute", backoffUntil - now);
    }
    if (count > this.maxPerMinute) {
      throw new RateLimitExceededError("minute", (minute + 1) * MINUTE_MS - now);
    }
  }

  /** SolaX said 10406: every instance holds off, not just the one that heard it. */
  async penalise(durationMs = 30_000): Promise<void> {
    try {
      await this.store.set(BACKOFF_KEY, this.now() + durationMs, durationMs);
    } catch {
      // Best effort; the local limiter already backs off on its own.
    }
  }
}
