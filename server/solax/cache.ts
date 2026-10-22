import { ZodError } from "zod";
import { SolaxCode, SolaxError } from "@core/solax/dto/envelope";
import type { KeyValueStore } from "../storage/kv";

/**
 * In-memory response cache with per-entry TTL and single-flight.
 *
 * This is what makes the call budget work. The dongle uploads roughly every
 * five minutes, so a realtime snapshot cached for a minute costs the user
 * nothing in freshness while cutting calls by an order of magnitude when the
 * dashboard is open in two tabs.
 *
 * Also serves stale data on failure: a five-minute-old reading — or a day-old
 * one from Upstash on a fresh instance — beats an empty dashboard, as long as
 * the UI can tell the difference. Hence `stale` on the result.
 */

/**
 * Versioned so a change in how responses are mapped invalidates every shared
 * entry at once. v2: timestamps in the plant's zone. v3: history summed across units. v4: units per slot.
 * v5: entries outlive their TTL (logical expiry inside the entry), so a v4 entry
 * written with a short physical TTL is never mistaken for a long-lived one.
 */
const L2_PREFIX = "cache:v5:";

/**
 * How long an entry physically survives in Upstash, regardless of its TTL.
 *
 * The TTL decides when a value is refreshed, not when it may still be shown. A
 * fresh serverless instance has an empty memory, so when SolaX refuses (10406)
 * or the local budget is spent, the only fallback is what Upstash still holds.
 * Expiring entries exactly at their TTL left nothing to fall back on and turned
 * every refusal into a failed panel.
 */
const L2_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** Which failures may be papered over with old data. Defaults to `isWorthServingStale`. */
  serveStaleOn?: (error: unknown) => boolean;
}

/**
 * True for failures that old data can honestly cover: refusals, timeouts,
 * outages. False for the ones that need a person — rejected credentials, an
 * endpoint outside the API package (10401/10402/10403) or a response that no
 * longer matches the schema. Serving stale data for those would keep the
 * dashboard quietly showing last week while the real problem never surfaces.
 */
export function isWorthServingStale(error: unknown): boolean {
  if (error instanceof ZodError) return false;
  if (error instanceof SolaxError) {
    return !(
      [SolaxCode.badCredentials, SolaxCode.tokenInvalid, SolaxCode.noInterfaceAccess] as number[]
    ).includes(error.code);
  }
  return true;
}

/** Error class and SolaX code, for logs: never the message or the request. */
function describeFailure(error: unknown): string {
  if (error instanceof SolaxError) return `SolaxError ${error.code}`;
  if (error instanceof Error) return error.name;
  return typeof error;
}

export class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly l2: KeyValueStore | null;
  private readonly serveStaleOn: (error: unknown) => boolean;

  constructor(options: TtlCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? 200;
    this.l2 = options.l2 ?? null;
    this.serveStaleOn = options.serveStaleOn ?? isWorthServingStale;
  }

  /**
   * Returns a cached value, or calls `load` once for all concurrent callers.
   *
   * When `load` throws — a 10406, a local budget refusal, a timeout — the most
   * recent entry from memory OR Upstash is returned with `stale: true` instead
   * of propagating the error, however old it is. With nothing cached anywhere,
   * or a failure `serveStaleOn` rejects (credentials, schema), the error
   * propagates.
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

    let shared: CacheEntry<T> | null = null;
    if (this.l2) {
      shared = await this.l2.get<CacheEntry<T>>(`${L2_PREFIX}${key}`).catch(() => null);
      if (shared && shared.expiresAt > now) {
        this.remember(key, shared);
        return { value: shared.value, stale: false, storedAt: shared.storedAt };
      }
    }

    // Whichever copy is newer: another instance may have refreshed Upstash
    // after this one last saw the key.
    const fallback =
      shared && (!existing || shared.storedAt > existing.storedAt) ? shared : (existing ?? null);

    try {
      const value = await this.loadOnce(key, ttlMs, load);
      return { value, stale: false, storedAt: this.now() };
    } catch (error) {
      if (serveStaleOnError && fallback && this.serveStaleOn(error)) {
        // Visible in the logs, or a SolaX outage would hide behind old data
        // for days. Class and code only: messages can carry request details.
        console.warn(
          `[cache] serving "${key}" stale (stored ${new Date(fallback.storedAt).toISOString()}) ` +
            `after ${describeFailure(error)}`,
        );
        // Kept in memory too, so the next request on this instance does not
        // need an Upstash round trip to find the same fallback.
        if (fallback !== existing) this.remember(key, fallback);
        return { value: fallback.value, stale: true, storedAt: fallback.storedAt };
      }
      throw error;
    }
  }

  /** Single-flight: concurrent misses share one `load`, success or failure. */
  private loadOnce<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = load()
      .then(async (value) => {
        this.set(key, value, ttlMs);
        const entry = this.entries.get(key);
        // Best effort: an Upstash hiccup must not fail a request that succeeded.
        if (this.l2 && entry) {
          await this.l2
            .set(`${L2_PREFIX}${key}`, entry, Math.max(ttlMs, L2_RETENTION_MS))
            .catch(() => undefined);
        }
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  private remember(key: string, entry: CacheEntry<unknown>): void {
    this.evictIfFull(key);
    this.entries.set(key, entry);
  }

  private evictIfFull(key: string): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      // Map preserves insertion order, so the first key is the oldest write.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.evictIfFull(key);
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
