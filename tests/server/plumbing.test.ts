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
import { Hono } from "hono";
import {
  KvReadingsStore,
  migrateReadingsFile,
  ReadingsError,
  ReadingsStore,
} from "../../server/billing/readings-store";
import { loadEnv } from "../../server/env";
import { apiErrorHandler, optional, registerApiRoutes } from "../../server/app";
import { runEnergyBank } from "@core/billing/services/energy-bank";
import { billHistory } from "@core/billing/services/consumption";
import type { KeyValueStore } from "../../server/storage/kv";
import { SolaxError } from "@core/solax/dto/envelope";
import { ZodError } from "zod";

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

/** In-memory stand-in for Upstash that records each key's physical TTL. */
function memoryKv(): KeyValueStore & { ttls: Map<string, number | undefined> } {
  const values = new Map<string, unknown>();
  const ttls = new Map<string, number | undefined>();
  return {
    ttls,
    async get<T>(key: string) {
      return (values.get(key) as T | undefined) ?? null;
    },
    async set<T>(key: string, value: T, ttlMs?: number) {
      values.set(key, value);
      ttls.set(key, ttlMs);
    },
    async incr() {
      return 1;
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

  it("serves an expired Upstash entry on a fresh instance when the load fails", async () => {
    // A cold serverless instance has an empty memory. Before, the shared
    // entry expired at its TTL, so a 10406 left nothing to show at all.
    const time = clock();
    const l2 = memoryKv();
    const warm = new TtlCache({ now: time.now, l2 });
    await warm.fetch("snapshot", 60_000, async () => "reading");
    expect(l2.ttls.get("cache:v5:snapshot")).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000);

    time.advance(60 * 60 * 1000);
    const cold = new TtlCache({ now: time.now, l2 });
    const result = await cold.fetch("snapshot", 60_000, async () => {
      throw new RateLimitExceededError("minute", 30_000);
    });
    expect(result).toMatchObject({ value: "reading", stale: true });
  });

  it("logs which key went stale and why, without the message", async () => {
    const time = clock();
    const cache = new TtlCache({ now: time.now });
    await cache.fetch("snapshot", 1000, async () => "reading");
    time.advance(1001);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await cache.fetch("snapshot", 1000, async () => {
      throw new SolaxError({ code: 10406, message: "secret-ish detail" });
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"snapshot".*SolaxError 10406/));
    expect(warn.mock.calls[0]?.[0]).not.toContain("secret-ish");
    warn.mockRestore();
  });

  it.each([
    ["rejected credentials", new SolaxError({ code: 10401, message: "bad" })],
    ["an endpoint outside the package", new SolaxError({ code: 10403, message: "no access" })],
    ["a schema change", new ZodError([])],
  ])("does not hide %s behind stale data", async (_label, failure) => {
    const time = clock();
    const cache = new TtlCache({ now: time.now });
    await cache.fetch("k", 1000, async () => "old");
    time.advance(1001);
    await expect(
      cache.fetch("k", 1000, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it("refreshes an expired Upstash entry when the load succeeds", async () => {
    const time = clock();
    const l2 = memoryKv();
    await new TtlCache({ now: time.now, l2 }).fetch("k", 1000, async () => "old");
    time.advance(1001);
    const result = await new TtlCache({ now: time.now, l2 }).fetch("k", 1000, async () => "new");
    expect(result).toMatchObject({ value: "new", stale: false });
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
      version: 2,
      carryoverKwh: 0,
      periods: [],
      readings: [],
      history: [],
    });
  });

  it("round-trips a reading and opens the first period with it", async () => {
    const { store } = await freshStore();
    await store.upsert({ takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 });

    const file = await store.load();
    expect(file.readings).toEqual([
      { takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 },
    ]);
    expect(file.periods).toEqual([{ start: "2026-09-18", end: null }]);
  });

  it("keeps several readings in the same month", async () => {
    // Regression: v1 keyed readings by month, so the second overwrote the first.
    const { store } = await freshStore();
    await store.updateMeter({ meterInstalledOn: "2026-09-15" });
    await store.upsert({ takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 });
    await store.upsert({ takenOn: "2026-09-30", importRegister: 290, exportRegister: 180 });

    const file = await store.load();
    expect(file.readings.map((r) => r.takenOn)).toEqual(["2026-09-18", "2026-09-30"]);
    expect(file.periods).toEqual([{ start: "2026-09-15", end: null }]);
  });

  it("replaces the reading already taken that day", async () => {
    const { store } = await freshStore();
    await store.upsert({ takenOn: "2026-09-18", importRegister: 60, exportRegister: 10 });
    await store.upsert({ takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 });

    const file = await store.load();
    expect(file.readings).toHaveLength(1);
    expect(file.readings[0]?.importRegister).toBe(61);
  });

  it("keeps readings chronological, whatever order they arrive in", async () => {
    const { store } = await freshStore();
    await store.updateMeter({ meterInstalledOn: "2026-01-01" });
    await store.upsert({ takenOn: "2026-05-06", importRegister: 2468, exportRegister: 3162 });
    await store.upsert({ takenOn: "2026-01-06", importRegister: 841, exportRegister: 1011 });
    await store.upsert({ takenOn: "2026-03-06", importRegister: 1490, exportRegister: 2288 });

    const file = await store.load();
    expect(file.readings.map((r) => r.takenOn)).toEqual([
      "2026-01-06",
      "2026-03-06",
      "2026-05-06",
    ]);
  });

  it("rejects a reading above the one taken after it", async () => {
    const { store } = await freshStore();
    await store.upsert({ takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 });
    await store.upsert({ takenOn: "2026-09-30", importRegister: 290, exportRegister: 180 });
    await expect(
      store.upsert({ takenOn: "2026-09-20", importRegister: 300, exportRegister: 20 }),
    ).rejects.toBeInstanceOf(ReadingsError);
  });

  it("rejects a reading before the first period", async () => {
    const { store } = await freshStore();
    await store.updateMeter({ meterInstalledOn: "2026-09-15" });
    await expect(
      store.upsert({ takenOn: "2026-09-01", importRegister: 1, exportRegister: 1 }),
    ).rejects.toThrow(/anterior al inicio/);
  });

  it("stores the meter-swap carryover", async () => {
    const { store } = await freshStore();
    await store.updateMeter({ carryoverKwh: 936 });
    expect((await store.load()).carryoverKwh).toBe(936);
  });

  it("removes a reading by its day", async () => {
    const { store } = await freshStore();
    await store.upsert({ takenOn: "2026-09-18", importRegister: 1, exportRegister: 2 });
    await store.remove("2026-09-18");
    expect((await store.load()).readings).toEqual([]);
  });

  it("does not leak rows between stores through the empty-file path", async () => {
    // Regression: `load()` returned a shallow spread of a module-level EMPTY
    // constant, so its `readings` array was shared. `upsert` pushed into it and
    // every later "empty" store in the process inherited the stale rows.
    const first = await freshStore();
    await first.store.upsert({ takenOn: "2026-05-06", importRegister: 2468, exportRegister: 3162 });

    const second = await freshStore();
    expect((await second.store.load()).readings).toEqual([]);

    await second.store.upsert({ takenOn: "2026-01-06", importRegister: 1, exportRegister: 2 });
    expect((await second.store.load()).readings).toHaveLength(1);
  });

  it.each(["18 sep", "2026-13-01", "2026-02-31"])(
    "rejects %s instead of filing it under another day",
    async (takenOn) => {
      const { store } = await freshStore();
      await expect(store.upsert({ takenOn, importRegister: 1, exportRegister: 2 })).rejects.toThrow();
      expect((await store.load()).readings).toEqual([]);
    },
  );

  it("rejects a reading from the future", async () => {
    const { store } = await freshStore();
    await expect(
      store.upsert({ takenOn: "2999-01-01", importRegister: 1, exportRegister: 2 }),
    ).rejects.toThrow(/futuro/);
  });

  it("refuses to silently accept a damaged file", async () => {
    const { dir } = await freshStore();
    await writeFile(
      join(dir, "cfe-readings.json"),
      JSON.stringify({ version: 2, readings: [{ takenOn: "nope" }] }),
      "utf8",
    );
    await expect(new ReadingsStore(dir).load()).rejects.toThrow(/not a valid readings file/);
  });

  it("writes readable JSON a human can repair", async () => {
    const { store, dir } = await freshStore();
    await store.upsert({ takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 });
    const raw = await readFile(join(dir, "cfe-readings.json"), "utf8");
    expect(raw).toContain('"takenOn": "2026-09-18"');
  });
});

describe("readings file migration v1 → v2", () => {
  const v1 = {
    version: 1,
    carryoverKwh: 1701,
    meterInstalledOn: "2026-08-01",
    readings: [
      { period: "2026-08", importRegister: 10, exportRegister: 5 },
      { period: "2026-09", importRegister: 61, exportRegister: 14, takenOn: "2026-09-18" },
    ],
    history: [{ period: "2026-08", kwh: 2188, amountMxn: 7283 }],
  };

  const expected = {
    version: 2,
    carryoverKwh: 1701,
    meterInstalledOn: "2026-08-01",
    periods: [{ start: "2026-08-01", end: null }],
    readings: [
      // No day recorded: the last day of its month, the latest it can be.
      { takenOn: "2026-08-31", importRegister: 10, exportRegister: 5, inferred: true },
      { takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 },
    ],
    history: [{ period: "2026-08", kwh: 2188, amountMxn: 7283 }],
  };

  it("migrates the local file when it is read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "solar-readings-"));
    await writeFile(join(dir, "cfe-readings.json"), JSON.stringify(v1), "utf8");
    expect(await new ReadingsStore(dir).load()).toEqual(expected);
  });

  it("migrates the Upstash copy the same way", async () => {
    const kv = memoryKv();
    await kv.set("cfe-readings", v1);
    expect(await new KvReadingsStore(kv).load()).toEqual(expected);
  });

  it("never infers a day after today for the current month", () => {
    const migrated = migrateReadingsFile(
      { ...v1, readings: [{ period: "2026-10", importRegister: 1, exportRegister: 1 }] },
      "2026-10-22",
    ) as { readings: { takenOn: string; inferred?: boolean }[] };
    expect(migrated.readings).toEqual([
      { takenOn: "2026-10-22", importRegister: 1, exportRegister: 1, inferred: true },
    ]);
  });

  it("lands an undated February reading on the 29th in a leap year", () => {
    const migrated = migrateReadingsFile(
      { ...v1, readings: [{ period: "2028-02", importRegister: 1, exportRegister: 1 }] },
      "2028-06-01",
    ) as { readings: { takenOn: string }[] };
    expect(migrated.readings[0]?.takenOn).toBe("2028-02-29");
  });

  it("opens the period at the earliest reading when no install date was saved", () => {
    const { meterInstalledOn: _, ...withoutDate } = v1;
    expect(migrateReadingsFile(withoutDate)).toMatchObject({
      periods: [{ start: "2026-08-31", end: null }],
    });
  });

  it("leaves a v2 document alone", () => {
    expect(migrateReadingsFile(expected)).toBe(expected);
  });

  it("backs up the v1 file once, before the first write replaces it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "solar-readings-"));
    await writeFile(join(dir, "cfe-readings.json"), JSON.stringify(v1), "utf8");
    const store = new ReadingsStore(dir);

    await store.upsert({ takenOn: "2026-09-30", importRegister: 100, exportRegister: 50 });
    const backup = join(dir, "cfe-readings.v1.bak.json");
    expect(JSON.parse(await readFile(backup, "utf8"))).toEqual(v1);

    // Later writes neither touch nor recreate it.
    await writeFile(backup, "kept", "utf8");
    await store.upsert({ takenOn: "2026-10-01", importRegister: 110, exportRegister: 60 });
    expect(await readFile(backup, "utf8")).toBe("kept");
  });

  it("backs up the Upstash copy under its own key, once", async () => {
    const kv = memoryKv();
    await kv.set("cfe-readings", v1);
    const store = new KvReadingsStore(kv);

    await store.upsert({ takenOn: "2026-09-30", importRegister: 100, exportRegister: 50 });
    expect(await kv.get("cfe-readings.v1.bak")).toEqual(v1);
    expect(await kv.get("cfe-readings")).toMatchObject({ version: 2 });

    await kv.set("cfe-readings.v1.bak", "kept");
    await store.upsert({ takenOn: "2026-10-01", importRegister: 110, exportRegister: 60 });
    expect(await kv.get("cfe-readings.v1.bak")).toBe("kept");
  });
});

describe("closing a billing period", () => {
  async function plantStore(history: { period: string; kwh: number; amountMxn?: number }[] = []) {
    const dir = await mkdtemp(join(tmpdir(), "solar-readings-"));
    if (history.length > 0) {
      await writeFile(
        join(dir, "cfe-readings.json"),
        JSON.stringify({ version: 2, carryoverKwh: 0, periods: [], readings: [], history }),
        "utf8",
      );
    }
    const store = new ReadingsStore(dir);
    await store.updateMeter({ meterInstalledOn: "2026-09-15", carryoverKwh: 1701 });
    await store.upsert({ takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 });
    return store;
  }

  async function closedStore() {
    const store = await plantStore();
    await store.upsert({ takenOn: "2026-10-07", importRegister: 435, exportRegister: 344 });
    await store.closePeriod("2026-10-07", bill);
    return store;
  }

  const bill = { kwh: 1792, totalMxn: 5472.38 };

  it("needs the cut date's reading first", async () => {
    const store = await plantStore();
    await expect(store.closePeriod("2026-10-07", bill)).rejects.toThrow(/Falta la lectura/);
  });

  it("closes the open period, opens the next and keeps the bill on it", async () => {
    const file = await (await closedStore()).load();

    expect(file.periods).toEqual([
      { start: "2026-09-15", end: "2026-10-07", bill },
      { start: "2026-10-07", end: null },
    ]);
    // The recibo's history is left alone; the bill shows up derived from the period.
    expect(file.history).toEqual([]);
    expect(billHistory(file.history, file.periods)).toEqual([
      { period: "2026-10", kwh: 1792, amountMxn: 5472.38 },
    ]);

    // And the bank agrees with the recibo.
    const bank = runEnergyBank(file, { carryoverKwh: file.carryoverKwh });
    expect(bank.periods[0]?.billedKwh).toBe(1792);
    expect(bank.open?.start).toBe("2026-10-07");
  });

  it("refuses a bill that contradicts the history for the same month", async () => {
    const store = await plantStore([{ period: "2026-10", kwh: 1700, amountMxn: 5000 }]);
    await store.upsert({ takenOn: "2026-10-07", importRegister: 435, exportRegister: 344 });
    await expect(store.closePeriod("2026-10-07", bill)).rejects.toMatchObject({ status: 409 });
  });

  it("accepts a bill the history already agrees with", async () => {
    const store = await plantStore([{ period: "2026-10", kwh: 1792, amountMxn: 5472.38 }]);
    await store.upsert({ takenOn: "2026-10-07", importRegister: 435, exportRegister: 344 });
    await expect(store.closePeriod("2026-10-07", bill)).resolves.toBeDefined();
  });

  it("refuses to delete the reading that closed a period", async () => {
    const store = await closedStore();
    await expect(store.remove("2026-10-07")).rejects.toMatchObject({ status: 409 });
  });

  it("refuses to change the registers of the reading that closed a period", async () => {
    const store = await closedStore();
    await expect(
      store.upsert({ takenOn: "2026-10-07", importRegister: 436, exportRegister: 344 }),
    ).rejects.toMatchObject({ status: 409 });
    // Re-saving the same values is harmless.
    await expect(
      store.upsert({ takenOn: "2026-10-07", importRegister: 435, exportRegister: 344 }),
    ).resolves.toBeDefined();
  });

  it("refuses a cut date on or before the period start, or in the future", async () => {
    const store = await plantStore();
    await expect(store.closePeriod("2026-09-15", bill)).rejects.toThrow(/posterior/);
    await expect(store.closePeriod("2999-01-01", bill)).rejects.toThrow(/futuro/);
  });

  it("undoes the last close while the next period is empty", async () => {
    const store = await closedStore();
    const file = await store.reopenLastPeriod();
    expect(file.periods).toEqual([{ start: "2026-09-15", end: null }]);
    expect(billHistory(file.history, file.periods)).toEqual([]);
    // The cut reading stays: it is just a reading again.
    expect(file.readings.map((r) => r.takenOn)).toContain("2026-10-07");
  });

  it("refuses to undo a close once the next period has readings", async () => {
    const store = await closedStore();
    await store.upsert({ takenOn: "2026-10-20", importRegister: 500, exportRegister: 400 });
    await expect(store.reopenLastPeriod()).rejects.toMatchObject({ status: 409 });
  });

  it("has nothing to undo before the first close", async () => {
    const store = await plantStore();
    await expect(store.reopenLastPeriod()).rejects.toMatchObject({ status: 409 });
  });
});

describe("billing routes", () => {
  async function billingApp() {
    const store = new ReadingsStore(await mkdtemp(join(tmpdir(), "solar-readings-")));
    await store.updateMeter({ meterInstalledOn: "2026-09-15" });
    const app = new Hono();
    registerApiRoutes(app, {
      env: loadEnv({
        SOLAX_BASE_URL: "https://example.test",
        SOLAX_CLIENT_ID: "id",
        SOLAX_CLIENT_SECRET: "secret",
        SOLAX_BUSINESS_TYPE: "1",
      } as NodeJS.ProcessEnv),
      // The billing routes below never touch SolaX.
      endpoints: {} as never,
      http: {} as never,
      tokenStore: {} as never,
      cache: new TtlCache(),
      readings: store,
    });
    app.onError(apiErrorHandler);
    return app;
  }

  const send = (method: string, body?: unknown) => ({
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const bill = { kwh: 1792, totalMxn: 5472.38 };

  it("closes and reopens a period over HTTP, with 400/409 for what it refuses", async () => {
    const app = await billingApp();

    // No reading on the cut date yet: refused with the reason.
    const early = await app.request("/api/billing/periods/close", send("POST", { end: "2026-10-07", bill }));
    expect(early.status).toBe(400);

    await app.request(
      "/api/billing/readings",
      send("PUT", { takenOn: "2026-10-07", importRegister: 435, exportRegister: 344 }),
    );
    const closed = await app.request("/api/billing/periods/close", send("POST", { end: "2026-10-07", bill }));
    expect(closed.status).toBe(200);
    expect(((await closed.json()) as { periods: unknown[] }).periods).toHaveLength(2);

    const deleted = await app.request("/api/billing/readings/2026-10-07", { method: "DELETE" });
    expect(deleted.status).toBe(409);

    const reopened = await app.request("/api/billing/periods/reopen", send("POST"));
    expect(reopened.status).toBe(200);
    expect(((await reopened.json()) as { periods: unknown[] }).periods).toHaveLength(1);

    const nothingLeft = await app.request("/api/billing/periods/reopen", send("POST"));
    expect(nothingLeft.status).toBe(409);
  });

  it.each([
    ["a reading on an impossible day", "/api/billing/readings", send("PUT", { takenOn: "2026-02-31", importRegister: 1, exportRegister: 1 })],
    ["a reading in a month that does not exist", "/api/billing/readings", send("PUT", { takenOn: "2026-13-01", importRegister: 1, exportRegister: 1 })],
    ["a cut on an impossible day", "/api/billing/periods/close", send("POST", { end: "2026-02-31", bill })],
    ["a future install date", "/api/billing/meter", send("PUT", { meterInstalledOn: "2999-01-01" })],
  ])("answers %s with 400", async (_label, path, init) => {
    const app = await billingApp();
    expect((await app.request(path, init)).status).toBe(400);
  });

  it("rejects an impossible day in the delete path", async () => {
    const app = await billingApp();
    expect((await app.request("/api/billing/readings/2026-02-31", { method: "DELETE" })).status).toBe(400);
  });

  it("no longer answers the old carryover alias", async () => {
    const app = await billingApp();
    app.all("/api/*", (c) => c.json({ error: "No such endpoint" }, 404));
    expect((await app.request("/api/billing/carryover", send("PUT", { carryoverKwh: 1 }))).status).toBe(404);
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

  it("defaults the per-minute budget to what SolaX really tolerates", () => {
    expect(loadEnv(valid as NodeJS.ProcessEnv).SOLAX_MAX_CALLS_PER_MINUTE).toBe(9);
  });

  it("clamps a stale, higher budget to 9 and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = loadEnv({ ...valid, SOLAX_MAX_CALLS_PER_MINUTE: "60" } as NodeJS.ProcessEnv);
    expect(env.SOLAX_MAX_CALLS_PER_MINUTE).toBe(9);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/SOLAX_MAX_CALLS_PER_MINUTE/));
    warn.mockRestore();
  });

  it("keeps a lower budget as given", () => {
    const env = loadEnv({ ...valid, SOLAX_MAX_CALLS_PER_MINUTE: "5" } as NodeJS.ProcessEnv);
    expect(env.SOLAX_MAX_CALLS_PER_MINUTE).toBe(5);
  });
});

describe("optional hardware probe", () => {
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

  it("reports absent hardware (10001) as none fitted", async () => {
    const warn = quiet();
    await expect(
      optional("batteries", async () => {
        throw new SolaxError({ code: 10001, message: "System exception" });
      }),
    ).resolves.toEqual([]);
    warn.mockRestore();
  });

  it("rethrows budget refusals, which must not be cached as none fitted", async () => {
    const refusals = [
      new RateLimitExceededError("minute", 30_000),
      new SolaxError({ code: 10406, message: "rate limited" }),
      new SolaxError({ code: 10405, message: "quota" }),
    ];
    for (const refusal of refusals) {
      await expect(
        optional("batteries", async () => {
          throw refusal;
        }),
      ).rejects.toBe(refusal);
    }
  });
});
