import { Redis } from "@upstash/redis";

/**
 * Minimal key/value port for state that must survive serverless cold starts.
 *
 * Locally everything lives in memory and a JSON file. On Vercel each
 * invocation may land on a fresh instance, so the SolaX token, the response
 * cache and the CFE readings go to Upstash Redis instead. Every key is
 * prefixed so this project can share an Upstash database with others.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
}

const PREFIX = "solar:";

export class UpstashStore implements KeyValueStore {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    return (await this.redis.get<T>(PREFIX + key)) ?? null;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    if (ttlMs !== undefined) {
      await this.redis.set(PREFIX + key, value, { px: Math.max(1, Math.round(ttlMs)) });
    } else {
      await this.redis.set(PREFIX + key, value);
    }
  }
}

/** Upstash when its REST credentials are configured, otherwise null. */
export function createUpstashStore(
  url: string | undefined,
  token: string | undefined,
): UpstashStore | null {
  if (!url || !token) return null;
  return new UpstashStore(new Redis({ url, token }));
}
