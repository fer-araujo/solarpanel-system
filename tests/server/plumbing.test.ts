import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../../server/solax/cache";
import {
  RateLimiter,
  RateLimitExceededError,
} from "../../server/solax/rate-limiter";
import { TokenStore } from "../../server/solax/token-store";
import { ReadingsStore } from "../../server/billing/readings-store";
import { loadEnv } from "../../server/env";

/** A controllable clock, so nothing here sleeps. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function tokenResponse(token: string, expiresIn = 2_591_999) {
  return new Response(
    JSON.stringify({
      code: 0,
      result: { access_token: token, token_type: "bearer", expires_in: expiresIn },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("TokenStore", () => {
  it("caches the token instead of re-authenticating per call", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse("tok-1"));
    const store = new TokenStore({
      baseUrl: "https://example.test",
      clientId: "id",
      clientSecret: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await store.get()).toBe("tok-1");
    expect(await store.get()).toBe("tok-1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("makes ONE token call for concurrent callers", async () => {
    // A cold start fans out into several dashboard requests at once; without
    // single-flight each would trigger its own token call.
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const store = new TokenStore({
      baseUrl: "https://example.test",
      clientId: "id",
      clientSecret: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const pending = Promise.all([store.get(), store.get(), store.get()]);
    resolveFetch?.(tokenResponse("tok-shared"));

    expect(await pending).toEqual(["tok-shared", "tok-shared", "tok-shared"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes before expiry rather than at it", async () => {
    const time = clock();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("tok-1", 3600))
      .mockResolvedValueOnce(tokenResponse("tok-2", 3600));

    const store = new TokenStore({
      baseUrl: "https://example.test",
      clientId: "id",
      clientSecret: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: time.now,
      refreshMarginMs: 600_000, // ten minutes
    });

    expect(await store.get()).toBe("tok-1");

    // 50 minutes in: still 10 minutes of life, but inside the margin.
    time.advance(50 * 60 * 1000);
    expect(await store.get()).toBe("tok-2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("re-authenticates after invalidate", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("tok-1"))
      .mockResolvedValueOnce(tokenResponse("tok-2"));

    const store = new TokenStore({
      baseUrl: "https://example.test",
      clientId: "id",
      clientSecret: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await store.get()).toBe("tok-1");
    store.invalidate();
    expect(await store.get()).toBe("tok-2");
  });

  it("explains a wrong base url rather than surfacing a bare 404", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const store = new TokenStore({
      baseUrl: "https://wrong.test",
      clientId: "id",
      clientSecret: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(store.get()).rejects.toThrow(/SOLAX_BASE_URL/);
  });

  it("rejects bad credentials with the documented code", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 10401, message: "bad" }), { status: 200 }),
    );
    const store = new TokenStore({
      baseUrl: "https://example.test",
      clientId: "id",
      clientSecret: "wrong",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(store.get()).rejects.toThrow(/Client id or secret is wrong/);
  });
});

describe("RateLimiter", () => {
  it("spends the per-minute budget and then refuses", () => {
    const time = clock();
    const limiter = new RateLimiter({ maxPerMinute: 3, now: time.now });

    limiter.take();
    limiter.take();
    limiter.take();
    expect(() => limiter.take()).toThrow(RateLimitExceededError);
  });

  it("lets the minute window slide", () => {
    const time = clock();
    const limiter = new RateLimiter({ maxPerMinute: 2, now: time.now });

    limiter.take();
    limiter.take();
    expect(() => limiter.take()).toThrow();

    time.advance(60_001);
    expect(() => limiter.take()).not.toThrow();
  });

  it("guards the daily quota separately, because it locks out for the day", () => {
    const time = clock();
    const limiter = new RateLimiter({
      maxPerMinute: 1000,
      maxPerDay: 2,
      now: time.now,
    });

    limiter.take();
    limiter.take();
    try {
      limiter.take();
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as RateLimitExceededError).scope).toBe("day");
    }
  });

  it("stops sending entirely after SolaX reports a rate limit", () => {
    const time = clock();
    const limiter = new RateLimiter({ maxPerMinute: 100, now: time.now });

    limiter.penalise(30_000);
    expect(() => limiter.take()).toThrow(RateLimitExceededError);

    time.advance(30_001);
    expect(() => limiter.take()).not.toThrow();
  });

  it("treats an exhausted quota as the day being over", () => {
    const limiter = new RateLimiter({ maxPerDay: 100 });
    limiter.markQuotaExhausted();
    expect(() => limiter.take()).toThrow(/daily/i);
  });
});

describe("TtlCache", () => {
  it("serves a hit without calling the loader again", async () => {
    const time = clock();
    const cache = new TtlCache({ now: time.now });
    const load = vi.fn(async () => 42);

    expect((await cache.fetch("k", 1000, load)).value).toBe(42);
    expect((await cache.fetch("k", 1000, load)).value).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads once the TTL passes", async () => {
    const time = clock();
    const cache = new TtlCache({ now: time.now });
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect((await cache.fetch("k", 1000, load)).value).toBe(1);
    time.advance(1001);
    expect((await cache.fetch("k", 1000, load)).value).toBe(2);
  });

  it("collapses concurrent misses into one load", async () => {
    const cache = new TtlCache();
    let resolveLoad: ((value: number) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const pending = Promise.all([
      cache.fetch("k", 1000, load),
      cache.fetch("k", 1000, load),
    ]);
    resolveLoad?.(7);

    const [a, b] = await pending;
    expect(a?.value).toBe(7);
    expect(b?.value).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serves stale data when a refresh fails, and says it is stale", async () => {
    const time = clock();
    const cache = new TtlCache({ now: time.now });
    const load = vi
      .fn()
      .mockResolvedValueOnce("fresh")
      .mockRejectedValueOnce(new Error("SolaX down"));

    expect((await cache.fetch("k", 1000, load)).stale).toBe(false);
    time.advance(1001);

    const second = await cache.fetch("k", 1000, load);
    expect(second.value).toBe("fresh");
    expect(second.stale).toBe(true);
  });

  it("propagates the error when there is nothing stale to fall back on", async () => {
    const cache = new TtlCache();
    await expect(
      cache.fetch("k", 1000, async () => {
        throw new Error("SolaX down");
      }),
    ).rejects.toThrow("SolaX down");
  });

  it("does not grow without bound", async () => {
    const cache = new TtlCache({ maxEntries: 3 });
    for (let i = 0; i < 10; i++) {
      await cache.fetch(`k${i}`, 10_000, async () => i);
    }
    expect(cache.size).toBeLessThanOrEqual(3);
  });

  it("invalidates by prefix", async () => {
    const cache = new TtlCache();
    await cache.fetch("stats:1:2026", 10_000, async () => "a");
    await cache.fetch("snapshot", 10_000, async () => "b");

    cache.invalidate("stats:");
    expect(cache.peek("stats:1:2026")).toBeUndefined();
    expect(cache.peek("snapshot")).toBeDefined();
  });
});

describe("ReadingsStore", () => {
  /**
   * Each test gets its own directory, created inside the test rather than in a
   * shared `beforeEach` variable. Sharing one made the cases order-dependent and
   * they leaked into each other.
   */
  async function freshStore(): Promise<{ store: ReadingsStore; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), "solar-readings-"));
    return { store: new ReadingsStore(dir), dir };
  }

  it("starts empty rather than failing on a missing file", async () => {
    const { store } = await freshStore();
    expect(await store.load()).toEqual({
      version: 1,
      carryoverKwh: 0,
      readings: [],
      history: [],
    });
  });

  it("round-trips a reading", async () => {
    const { store } = await freshStore();
    await store.upsert({ period: "2026-01", importRegister: 841, exportRegister: 1011 });

    const file = await store.load();
    expect(file.readings).toEqual([
      { period: "2026-01", importRegister: 841, exportRegister: 1011 },
    ]);
  });

  it("replaces a reading for a period already recorded", async () => {
    const { store } = await freshStore();
    await store.upsert({ period: "2026-01", importRegister: 800, exportRegister: 1000 });
    await store.upsert({ period: "2026-01", importRegister: 841, exportRegister: 1011 });

    const file = await store.load();
    expect(file.readings).toHaveLength(1);
    expect(file.readings[0]?.importRegister).toBe(841);
  });

  it("keeps readings chronological, whatever order they arrive in", async () => {
    const { store } = await freshStore();
    await store.upsert({ period: "2026-05", importRegister: 2468, exportRegister: 3162 });
    await store.upsert({ period: "2026-01", importRegister: 841, exportRegister: 1011 });
    await store.upsert({ period: "2026-03", importRegister: 1490, exportRegister: 2288 });

    const file = await store.load();
    expect(file.readings.map((r) => r.period)).toEqual([
      "2026-01",
      "2026-03",
      "2026-05",
    ]);
  });

  it("stores the meter-swap carryover", async () => {
    const { store } = await freshStore();
    await store.setCarryover(936);
    expect((await store.load()).carryoverKwh).toBe(936);
  });

  it("removes a reading", async () => {
    const { store } = await freshStore();
    await store.upsert({ period: "2026-01", importRegister: 1, exportRegister: 2 });
    await store.remove("2026-01");
    expect((await store.load()).readings).toEqual([]);
  });

  it("does not leak rows between stores through the empty-file path", async () => {
    // Regression: `load()` returned a shallow spread of a module-level EMPTY
    // constant, so its `readings` array was shared. `upsert` pushed into it and
    // every later "empty" store in the process inherited the stale rows.
    const first = await freshStore();
    await first.store.upsert({
      period: "2026-05",
      importRegister: 2468,
      exportRegister: 3162,
    });

    const second = await freshStore();
    expect((await second.store.load()).readings).toEqual([]);

    await second.store.upsert({
      period: "2026-01",
      importRegister: 1,
      exportRegister: 2,
    });
    expect((await second.store.load()).readings).toHaveLength(1);
  });

  it("rejects a malformed period instead of corrupting the series", async () => {
    const { store } = await freshStore();
    await expect(
      store.upsert({ period: "enero", importRegister: 1, exportRegister: 2 }),
    ).rejects.toThrow();
  });

  it("refuses to silently accept a damaged file", async () => {
    const { dir } = await freshStore();
    await writeFile(
      join(dir, "cfe-readings.json"),
      JSON.stringify({ version: 1, readings: [{ period: "nope" }] }),
      "utf8",
    );
    await expect(new ReadingsStore(dir).load()).rejects.toThrow(/not a valid readings file/);
  });

  it("writes readable JSON a human can repair", async () => {
    const { store, dir } = await freshStore();
    await store.upsert({ period: "2026-01", importRegister: 841, exportRegister: 1011 });
    const raw = await readFile(join(dir, "cfe-readings.json"), "utf8");
    expect(raw).toContain('"period": "2026-01"');
  });
});

describe("loadEnv", () => {
  const valid = {
    SOLAX_BASE_URL: "https://openapi-eu.solaxcloud.com",
    SOLAX_CLIENT_ID: "abc",
    SOLAX_CLIENT_SECRET: "shh",
    SOLAX_BUSINESS_TYPE: "1",
  };

  it("accepts a complete environment", () => {
    const env = loadEnv(valid as NodeJS.ProcessEnv);
    expect(env.SOLAX_BUSINESS_TYPE).toBe(1);
    expect(env.PORT).toBe(8787);
  });

  it("names every missing variable at once", () => {
    try {
      loadEnv({} as NodeJS.ProcessEnv);
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("SOLAX_BASE_URL");
      expect(message).toContain("SOLAX_CLIENT_ID");
      expect(message).toContain("SOLAX_CLIENT_SECRET");
    }
  });

  it("rejects a trailing slash, which would produce a double-slash path", () => {
    expect(() =>
      loadEnv({
        ...valid,
        SOLAX_BASE_URL: "https://openapi-eu.solaxcloud.com/",
      } as NodeJS.ProcessEnv),
    ).toThrow(/slash/);
  });

  it("rejects a business type that is neither Residential nor C&I", () => {
    expect(() =>
      loadEnv({ ...valid, SOLAX_BUSINESS_TYPE: "2" } as NodeJS.ProcessEnv),
    ).toThrow(/1 \(Residential\) or 4/);
  });
});
