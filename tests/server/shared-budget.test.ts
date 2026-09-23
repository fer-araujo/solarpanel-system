import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "../../server/storage/kv";
import { SharedBudget } from "../../server/solax/shared-budget";
import { RateLimitExceededError } from "../../server/solax/rate-limiter";

/** In-memory stand-in for Upstash, shared by every "instance" in a test. */
function memoryStore(): KeyValueStore & { failing: boolean } {
  const values = new Map<string, unknown>();
  const store = {
    failing: false,
    async get<T>(key: string) {
      if (store.failing) throw new Error("down");
      return (values.get(key) as T | undefined) ?? null;
    },
    async set<T>(key: string, value: T) {
      if (store.failing) throw new Error("down");
      values.set(key, value);
    },
    async incr(key: string) {
      if (store.failing) throw new Error("down");
      const next = ((values.get(key) as number | undefined) ?? 0) + 1;
      values.set(key, next);
      return next;
    },
  };
  return store;
}

describe("shared SolaX budget", () => {
  const now = () => 1_000_000;

  it("counts calls from every instance against one limit", async () => {
    const store = memoryStore();
    const a = new SharedBudget(store, 3, now);
    const b = new SharedBudget(store, 3, now);
    await a.take();
    await b.take();
    await a.take();
    await expect(b.take()).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it("makes every instance hold off after one hears 10406", async () => {
    const store = memoryStore();
    const a = new SharedBudget(store, 100, now);
    const b = new SharedBudget(store, 100, now);
    await a.penalise(30_000);
    await expect(b.take()).rejects.toMatchObject({ retryAfterMs: 30_000 });
  });

  it("fails open when Upstash is unreachable", async () => {
    const store = memoryStore();
    store.failing = true;
    await expect(new SharedBudget(store, 1, now).take()).resolves.toBeUndefined();
  });
});
