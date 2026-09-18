/**
 * Guards the SolaX call budget.
 *
 * Two independent limits exist and they fail differently: a per-minute rate
 * (code 10406, transient) and a daily quota (code 10405, which locks you out
 * until midnight). The daily one is the dangerous one — burning it means no
 * data at all for the rest of the day, so calls are refused locally before they
 * are ever sent rather than discovering the wall from the server.
 *
 * Deliberately conservative: the dongle only uploads every ~5 minutes, so
 * polling faster buys nothing and spends quota.
 */

export interface RateLimiterOptions {
  maxPerMinute?: number;
  maxPerDay?: number;
  /** Injectable for tests. */
  now?: () => number;
}

export class RateLimitExceededError extends Error {
  readonly scope: "minute" | "day";
  readonly retryAfterMs: number;

  constructor(scope: "minute" | "day", retryAfterMs: number) {
    super(
      scope === "minute"
        ? `Local per-minute SolaX budget spent; retry in ${Math.ceil(retryAfterMs / 1000)}s`
        : `Local daily SolaX quota spent; resets in ${Math.ceil(retryAfterMs / 60000)} min`,
    );
    this.name = "RateLimitExceededError";
    this.scope = scope;
    this.retryAfterMs = retryAfterMs;
  }
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class RateLimiter {
  private readonly maxPerMinute: number;
  private readonly maxPerDay: number;
  private readonly now: () => number;

  /** Timestamps within the trailing minute. */
  private recent: number[] = [];
  private dayCount = 0;
  private dayStart: number;
  /** Set when SolaX itself returns 10406; no calls go out until it passes. */
  private backoffUntil = 0;

  constructor(options: RateLimiterOptions = {}) {
    // Public guidance for the user API is under 10 calls/min and 10,000/day.
    // A little headroom is kept under both.
    this.maxPerMinute = options.maxPerMinute ?? 8;
    this.maxPerDay = options.maxPerDay ?? 9_000;
    this.now = options.now ?? Date.now;
    this.dayStart = this.now();
  }

  /** Throws rather than queueing, so a caller can degrade instead of hanging. */
  take(): void {
    const now = this.now();

    if (now >= this.dayStart + DAY_MS) {
      this.dayStart = now;
      this.dayCount = 0;
    }

    if (now < this.backoffUntil) {
      throw new RateLimitExceededError("minute", this.backoffUntil - now);
    }

    if (this.dayCount >= this.maxPerDay) {
      throw new RateLimitExceededError("day", this.dayStart + DAY_MS - now);
    }

    this.recent = this.recent.filter((at) => now - at < MINUTE_MS);
    if (this.recent.length >= this.maxPerMinute) {
      const oldest = this.recent[0] ?? now;
      throw new RateLimitExceededError("minute", oldest + MINUTE_MS - now);
    }

    this.recent.push(now);
    this.dayCount += 1;
  }

  /**
   * Called when SolaX returns 10406. Our local counter thought there was room,
   * so the server's window disagrees with ours — stop sending for a while
   * instead of hammering into the limit.
   */
  penalise(durationMs = 30_000): void {
    this.backoffUntil = this.now() + durationMs;
  }

  /** Called when SolaX returns 10405: nothing more will work today. */
  markQuotaExhausted(): void {
    this.dayCount = this.maxPerDay;
  }

  snapshot(): {
    perMinuteUsed: number;
    perMinuteLimit: number;
    perDayUsed: number;
    perDayLimit: number;
    backoffMsRemaining: number;
  } {
    const now = this.now();
    this.recent = this.recent.filter((at) => now - at < MINUTE_MS);
    return {
      perMinuteUsed: this.recent.length,
      perMinuteLimit: this.maxPerMinute,
      perDayUsed: this.dayCount,
      perDayLimit: this.maxPerDay,
      backoffMsRemaining: Math.max(0, this.backoffUntil - now),
    };
  }
}
