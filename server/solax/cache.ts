/**
 * In-memory response cache with per-entry TTL and single-flight.
 *
 * This is what makes the call budget work. The dongle uploads roughly every
 * five minutes, so a realtime snapshot cached for a minute costs the user
 * nothing in freshness while cutting calls by an order of magnitude when the
 * dashboard is open in two tabs.
 *
 * Also serves stale data on failure when asked to: a five-minute-old reading
 * beats an empty dashboard, as long as the UI can tell the difference — hence
 * `stale` on the result.
 */

export interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export interface CachedResult<T> {
  value: T;
  /** True when the value was served past its TTL because the refresh failed. */
  stale: boolean;
  storedAt: number;
}

export interface TtlCacheOptions {
  now?: () => number;
  /** Hard cap on entries, so a bug in key construction cannot grow forever. */
  maxEntries?: number;
}

export class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(options: TtlCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 200;
  }

  /**
   * Returns a cached value, or calls `load` once for all concurrent callers.
   *
   * When `load` throws and a stale entry exists, the stale entry is returned
   * with `stale: true` instead of propagating the error — the caller decides
   * whether that is acceptable. With no entry at all, the error propagates.
   */
  async fetch<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    options: { serveStaleOnError?: boolean } = {},
  ): Promise<CachedResult<T>> {
    const { serveStaleOnError = true } = options;
    const now = this.now();
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;

    if (existing && existing.expiresAt > now) {
      return { value: existing.value, stale: false, storedAt: existing.storedAt };
    }

    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
      const value = await pending;
      return { value, stale: false, storedAt: this.now() };
    }

    const promise = load()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);

    try {
      const value = await promise;
      return { value, stale: false, storedAt: this.now() };
    } catch (error) {
      if (serveStaleOnError && existing) {
        return { value: existing.value, stale: true, storedAt: existing.storedAt };
      }
      throw error;
    }
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Map preserves insertion order, so the first key is the oldest write.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    const now = this.now();
    this.entries.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
  }

  peek<T>(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key) as CacheEntry<T> | undefined;
  }

  invalidate(keyPrefix?: string): void {
    if (keyPrefix === undefined) {
      this.entries.clear();
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(keyPrefix)) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
