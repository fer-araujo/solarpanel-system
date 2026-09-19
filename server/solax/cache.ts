import type { KeyValueStore } from "../storage/kv";

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

/**
 * Versioned so a change in how responses are mapped invalidates every shared
 * entry at once. v2: timestamps in the plant's zone. v3: history summed across units. v4: units per slot.
 */
const L2_PREFIX = "cache:v4:";

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
  /**
   * Shared second level (Upstash) behind the in-memory map. On serverless a
   * cold instance starts empty; without this it would re-spend SolaX calls on
   * data another instance fetched seconds ago.
   */
  l2?: KeyValueStore;
}

export class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly l2: KeyValueStore | null;

  constructor(options: TtlCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 200;
    this.l2 = options.l2 ?? null;
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

    if (this.l2) {
      const shared = await this.l2.get<CacheEntry<T>>(`${L2_PREFIX}${key}`).catch(() => null);
      if (shared && shared.expiresAt > now) {
        this.entries.set(key, shared);
        return { value: shared.value, stale: false, storedAt: shared.storedAt };
      }
    }

    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
      const value = await pending;
      return { value, stale: false, storedAt: this.now() };
    }

    const promise = load()
      .then(async (value) => {
        this.set(key, value, ttlMs);
        const entry = this.entries.get(key);
        // Best effort: an Upstash hiccup must not fail a request that succeeded.
        if (this.l2 && entry) await this.l2.set(`${L2_PREFIX}${key}`, entry, ttlMs).catch(() => undefined);
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
