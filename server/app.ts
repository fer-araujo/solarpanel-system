import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import type { InverterRealtimeDto } from "@core/solax/dto/device";
import { SolaxError } from "@core/solax/dto/envelope";
import {
  mapAggregateSnapshot,
  mapAllPvStrings,
  mapBatteryState,
  mapInverterState,
  mapAggregateHistory,
} from "@core/solax/mappers/snapshot";
import { mapTopology } from "@core/solax/mappers/topology";
import { effectivePvKwh, normalizeStatEntries } from "@core/solax/mappers/stats";
import { plantDayBoundsFor, plantLocalDayBounds } from "@core/solax/mappers/units";
import type { SystemTopology } from "@core/energy/model/power";
import { CFE_1C } from "@core/billing/data/cfe-1c";
import { addDays, daysBetween } from "@core/billing/model/meter-reading";
import { scheduleForPeriodEnd } from "@core/billing/model/tariff";
import {
  projectBankDepletion,
  runEnergyBank,
} from "@core/billing/services/energy-bank";
import {
  assessDacRisk,
  bimonthlyToMonthly,
  type DacBasis,
} from "@core/billing/services/dac-risk";
import { savingsFromOffset } from "@core/billing/services/price-energy";
import {
  balancePeriod,
  summarizeBalances,
  type PeriodBalance,
} from "@core/billing/services/period-balance";
import type { Env } from "./env";
import type { TtlCache } from "./solax/cache";
import {
  HISTORY_MAX_WINDOW_MS,
  type HistoryInterval,
  type SolaxEndpoints,
} from "./solax/endpoints";
import { RateLimitExceededError, type SolaxHttpClient } from "./solax/http-client";
import { RATE_LIMIT_PENALTY_MS } from "./solax/rate-limiter";
import type { TokenStore } from "./solax/token-store";
import {
  billSchema,
  readingSchema,
  ReadingsError,
  type ReadingsRepository,
} from "./billing/readings-store";

/**
 * The HTTP surface.
 *
 * Two rules shape everything here:
 *
 * 1. Routes return DOMAIN models, never SolaX DTOs. The client never sees
 *    `feedinpowerM2` and never decides what a sign means.
 * 2. Every SolaX-backed route goes through the cache. The daily quota is a hard
 *    resource, and two open browser tabs must not cost twice the calls.
 */

export interface AppDeps {
  env: Env;
  endpoints: SolaxEndpoints;
  http: SolaxHttpClient;
  tokenStore: TokenStore;
  cache: TtlCache;
  readings: ReadingsRepository;
}

/**
 * TTLs are tuned to the dongle, which uploads about every five minutes. A
 * shorter snapshot TTL would spend quota for data that has not changed.
 */
const TTL = {
  topology: 6 * 60 * 60 * 1000,
  /**
   * Optional hardware (battery, meter, EV charger). Absent hardware answers
   * with a generic 10001, so probing it on every topology refresh spent three
   * failing calls each time. What is fitted changes rarely; a day is plenty.
   */
  hardwareProbe: 24 * 60 * 60 * 1000,
  snapshot: 60 * 1000,
  history: 5 * 60 * 1000,
  /**
   * A 12-hour history window that has already ended is immutable, so it is
   * fetched once and kept. Re-requesting it would spend calls to receive
   * byte-identical data.
   */
  closedHistoryWindow: 12 * 60 * 60 * 1000,
  stats: 60 * 60 * 1000,
  /** The current month or year still gains today's production; refresh it sooner. */
  currentStats: 10 * 60 * 1000,
  /**
   * A month or year that ended is final. The heatmap and the CFE balance read
   * up to a year of them, so re-fetching every hour spent a dozen calls on
   * numbers that cannot change.
   */
  closedStats: 30 * 24 * 60 * 60 * 1000,
  alarms: 5 * 60 * 1000,
} as const;

const historyIntervalSchema = z
  .enum(["5", "10", "15", "30", "60"])
  .transform((value) => Number(value) as HistoryInterval);

/**
 * True for a refusal of the call itself rather than an answer about the
 * plant: the local budget, SolaX's 10406 burst limit or its 10405 daily quota.
 */
function isBudgetError(error: unknown): boolean {
  if (error instanceof RateLimitExceededError) return true;
  return error instanceof SolaxError && (error.isRateLimit || error.isQuotaExhausted);
}

/**
 * Runs a probe for OPTIONAL hardware, treating a failure as "none fitted".
 *
 * Querying `page_device_info` for a device class the plant does not have can
 * come back as a generic 10001 rather than an empty list. Letting that
 * propagate would mean a plant with no battery cannot load its dashboard at
 * all, so the failure is logged and reported as absence.
 *
 * A budget refusal is NOT absence: the question was never answered. Swallowing
 * it cached "no battery" for a day after a single 10406, so it propagates and
 * the cache falls back to the last real answer instead.
 */
export async function optional<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (error) {
    if (isBudgetError(error)) throw error;
    console.warn(
      `[api] optional probe "${label}" failed, treating as none fitted: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * For extras whose absence only thins a response (alarms, PV for the CFE
 * balance) and whose empty result is never cached: any failure, budget
 * refusals included, degrades to an empty list instead of failing the route.
 */
async function bestEffort<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (error) {
    console.warn(
      `[api] "${label}" unavailable, continuing without it: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Cache lifetime for a `get_stat_data` period (`YYYY` or `YYYY-MM`), judged
 * in plant-local time so the current period is recognised on a UTC server.
 *
 * The current period still grows. One that ended in the last two days may
 * still receive the dongle's late uploads, so it keeps the hourly TTL; older
 * periods are final.
 */
function statsTtl(date: string, utcOffsetMinutes: number | null): number {
  const plantNow = Date.now() + (utcOffsetMinutes ?? 0) * 60_000;
  if (new Date(plantNow).toISOString().startsWith(date)) return TTL.currentStats;
  const twoDaysAgo = new Date(plantNow - 2 * 86_400_000).toISOString();
  return twoDaysAgo.startsWith(date) ? TTL.stats : TTL.closedStats;
}

/**
 * Registers the API on an EXISTING app rather than building its own.
 *
 * This used to return a sub-app that the entrypoint mounted with
 * `app.route("/", ...)`, and the error handler went on the sub-app. Errors then
 * escaped to the outer app, which had no handler, so every failure surfaced as
 * a bare 500 with the real cause lost. One app, one error handler.
 */
export function registerApiRoutes(app: Hono, deps: AppDeps): Hono {
  const { env, endpoints, http, tokenStore, cache, readings } = deps;
  const businessType = env.SOLAX_BUSINESS_TYPE as 1 | 4;

  /**
   * One realtime call serves both the topology's samples and the snapshot: on
   * a cold load they are requested within seconds of each other, and the
   * second call would buy identical numbers.
   *
   * No stale fallback here — the caller's own cache decides that, so a stale
   * reading is never re-cached as a fresh snapshot.
   */
  async function realtime(serials: string[]): Promise<InverterRealtimeDto[]> {
    const cached = await cache.fetch(
      `realtime:${serials.join(",")}`,
      TTL.snapshot,
      () => endpoints.getInverterRealtime(serials),
      { serveStaleOnError: false },
    );
    return cached.value;
  }

  /** Resolves and caches what the plant actually has fitted. */
  async function topology(): Promise<SystemTopology> {
    const cached = await cache.fetch("topology", TTL.topology, async () => {
      const plants = await endpoints.listPlants();
      const plant = plants[0];
      if (!plant) {
        throw new SolaxError({
          code: -1,
          message:
            "The application sees no plants. Check that the SolaXCloud account " +
            "owning the panels authorised this Developer Portal application.",
        });
      }

      const inverters = await endpoints.listInverters(plant.plantId);

      // Optional hardware. SolaX answers a query for a device class the plant
      // does not have with a generic failure rather than an empty list, so a
      // missing battery must not take the whole dashboard down with it.
      const probe = async <T>(label: string, run: () => Promise<T[]>): Promise<T[]> =>
        (await cache.fetch(`probe:${label}`, TTL.hardwareProbe, () => optional(label, run))).value;
      const batteries = await probe("batteries", () => endpoints.listBatteries(plant.plantId));
      const meters = await probe("meters", () => endpoints.listMeters(plant.plantId));
      const evChargers = await probe("evChargers", () => endpoints.listEvChargers(plant.plantId));

      // EVERY inverter: a microinverter array reports one device per unit, and
      // sampling only the first undercounts both production and panels.
      const serials = inverters.map((inverter) => inverter.deviceSn).slice(0, 10);
      const samples = serials.length > 0 ? await realtime(serials) : [];

      return mapTopology({
        plant,
        inverters,
        batteries,
        meters,
        evChargers,
        samples,
        businessType,
      });
    });

    return cached.value;
  }

  app.get("/api/health", async (context) => {
    return context.json({
      ok: true,
      baseUrl: env.SOLAX_BASE_URL,
      businessType,
      token: tokenStore.snapshot(),
      budget: http.rateLimiter.snapshot(),
      cacheEntries: cache.size,
    });
  });

  /**
   * Probes each endpoint the dashboard needs, in isolation, and reports what
   * each one did.
   *
   * SolaX's generic failure code (10001, "System exception") says nothing about
   * which call or which parameter is at fault, and the endpoints a given
   * account may call depend on its API service package. Rather than bisect one
   * failure per round trip, this spends a handful of calls once and returns the
   * whole picture.
   *
   * Deliberately sequential and short: the per-minute budget is 8.
   */
  app.get("/api/diag", async (context) => {
    const probes: {
      name: string;
      run: () => Promise<unknown>;
    }[] = [
      { name: "plant/page_plant_info", run: () => endpoints.listPlants() },
      {
        name: "device/page_device_info (inverter)",
        run: () => endpoints.listInverters(),
      },
      {
        name: "device/page_device_info (meter)",
        run: () => endpoints.listMeters(),
      },
      {
        name: "device/page_device_info (battery)",
        run: () => endpoints.listBatteries(),
      },
      {
        name: "device/page_device_info (ev charger)",
        run: () => endpoints.listEvChargers(),
      },
    ];

    const results: Record<string, unknown>[] = [];
    let serials: string[] = [];

    async function record(name: string, run: () => Promise<unknown>) {
      try {
        const value = await run();
        results.push({
          endpoint: name,
          ok: true,
          records: Array.isArray(value) ? value.length : null,
          sample: Array.isArray(value) ? (value[0] ?? null) : value,
        });
        return value;
      } catch (error) {
        results.push({
          endpoint: name,
          ok: false,
          solaxCode: error instanceof SolaxError ? error.code : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    for (const probe of probes) {
      const value = await record(probe.name, probe.run);
      if (probe.name.includes("inverter") && Array.isArray(value)) {
        serials = (value as { deviceSn: string }[])
          .map((device) => device.deviceSn)
          .slice(0, 10);
      }
    }

    // The two endpoints /api/snapshot actually depends on. These are the most
    // likely source of a failure that the list probes above do not reproduce.
    if (serials.length > 0) {
      await record("device/realtime_data (inverter)", () =>
        endpoints.getInverterRealtime(serials),
      );
      await record("device/data/realtime (inverter + alarms)", () =>
        endpoints.getInverterRealtimeWithAlarms(serials),
      );
    }

    return context.json({
      baseUrl: env.SOLAX_BASE_URL,
      businessType,
      token: tokenStore.snapshot(),
      budget: http.rateLimiter.snapshot(),
      results,
    });
  });

  app.get("/api/topology", async (context) => {
    return context.json(await topology());
  });

  app.get("/api/snapshot", async (context) => {
    const system = await topology();
    const serials = system.inverterSerialNumbers.slice(0, 10);
    if (serials.length === 0) {
      return context.json({ error: "No inverters visible to this application" }, 404);
    }

    // Alarms come from their own endpoint, cached at their own rate. See the
    // note below for why they are not taken from the realtime call.
    const alarms = await bestEffort("alarms", async () => {
      const cached = await cache.fetch(`alarms:1`, TTL.alarms, () =>
        endpoints.listAlarms({ plantId: system.plantId, alarmState: 1 }),
      );
      return cached.value;
    });

    const result = await cache.fetch("snapshot", TTL.snapshot, async () => {
      /**
       * Uses `device/realtime_data`, NOT `device/data/realtime`.
       *
       * The latter bundles the five most recent alarms into the realtime
       * response, which would have saved a call — but it returns HTTP 500 on
       * this account. Its documentation is self-contradictory too (declared GET
       * with query params, illustrated with a JSON body), so it is treated as
       * unreliable. `alarm/page_alarm_info` is a documented, working endpoint
       * and its data changes slowly enough to cache separately.
       */
      const inverters = await realtime(serials);
      if (inverters.length === 0) {
        throw new SolaxError({ code: -1, message: "Inverters returned no data" });
      }

      // Only ask for battery data when one is actually fitted; the query fails
      // rather than returning empty when there is none.
      const batteries = system.hasBattery
        ? await optional("batteryRealtime", () =>
            endpoints.getBatteryRealtime(serials, "inverter"),
          )
        : [];
      const battery = batteries[0] ?? null;

      return {
        power: mapAggregateSnapshot({
          inverters,
          battery,
          businessType,
          batteryCapacityKwh: system.batteryCapacityKwh,
          utcOffsetMinutes: system.utcOffsetMinutes,
        }),
        strings: mapAllPvStrings(inverters, businessType),
        // One entry per unit, so each microinverter's status and temperature
        // stay individually visible.
        inverters: inverters.map((inverter) =>
          mapInverterState(inverter, businessType),
        ),
        battery: battery ? mapBatteryState(battery, system.batteryCapacityKwh) : null,
        alarms,
      };
    });

    return context.json({ ...result.value, stale: result.stale, at: result.storedAt });
  });

  // `?date=YYYY-MM-DD` selects any day in the past year; without it, today.
  app.on("GET", ["/api/history/today", "/api/history/day"], async (context) => {
    const system = await topology();
    const serials = system.inverterSerialNumbers.slice(0, 10);
    if (serials.length === 0) {
      return context.json({ error: "No inverters visible to this application" }, 404);
    }

    const parsedInterval = historyIntervalSchema.safeParse(
      context.req.query("interval") ?? "5",
    );
    if (!parsedInterval.success) {
      return context.json({ error: "interval must be one of 5, 10, 15, 30, 60" }, 400);
    }
    const interval = parsedInterval.data;

    const requested = context.req.query("date");
    if (requested !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
      return context.json({ error: "date must be YYYY-MM-DD" }, 400);
    }
    const bounds = requested
      ? plantDayBoundsFor(requested, system.timeZone)
      : plantLocalDayBounds(system.timeZone);
    // One clock reading for the whole request: comparing two separate
    // Date.now() calls made the window containing "now" look closed.
    const now = Date.now();
    const endMs = Math.min(bounds.endMs, now);
    if (endMs <= bounds.startMs) {
      return context.json({ samples: [], interval, dayBoundsExact: bounds.exact, stale: false });
    }

    /**
     * Fetched and cached PER 12-HOUR WINDOW rather than as a whole day.
     *
     * SolaX caps a history request at 12 hours, so a day is two calls. But a
     * window that has already ended can never change, so re-fetching it every
     * few minutes spends the call budget to receive identical bytes. Completed
     * windows are cached for the rest of the day; only the window containing
     * "now" is refreshed.
     *
     * This roughly halves the day's history calls, and more on a long day.
     */
    const windows: { startMs: number; endMs: number; key: string; closed: boolean }[] = [];
    for (
      let cursor = bounds.startMs;
      cursor < endMs;
      cursor += HISTORY_MAX_WINDOW_MS
    ) {
      // Keyed by the window's natural end, so the open window reuses one cache
      // entry for its TTL instead of writing a new one on every request.
      const naturalEnd = Math.min(cursor + HISTORY_MAX_WINDOW_MS, bounds.endMs);
      const closed = naturalEnd <= now;
      windows.push({
        startMs: cursor,
        endMs: Math.min(naturalEnd, now),
        key: `history:${interval}:${cursor}-${naturalEnd}:${closed ? "closed" : "open"}`,
        closed,
      });
    }

    let anyStale = false;
    const samples: ReturnType<typeof mapAggregateHistory> = [];

    for (const window of windows) {
      // Any window fully in the past is immutable — including every window of
      // a past day — so it is fetched once and kept.
      const windowResult = await cache.fetch(
        window.key,
        window.closed ? TTL.closedHistoryWindow : TTL.history,
        async () => {
          // One request per unit, then summed per time slot, so the curve is
          // the whole array however SolaX lays out a multi-serial response.
          const raw: InverterRealtimeDto[] = [];
          for (const serial of serials) {
            raw.push(
              ...(await endpoints.getInverterHistoryWindow({
                serialNumbers: [serial],
                interval,
                startMs: window.startMs,
                endMs: window.endMs,
              })),
            );
          }
          return mapAggregateHistory(raw, {
            businessType,
            utcOffsetMinutes: system.utcOffsetMinutes,
            intervalMinutes: interval,
          });
        },
      );
      if (windowResult.stale) anyStale = true;
      samples.push(...windowResult.value);
    }

    return context.json({
      samples,
      interval,
      // Surfaced rather than hidden: without a parseable plant offset these are
      // the server's day boundaries, not the plant's.
      dayBoundsExact: bounds.exact,
      stale: anyStale,
    });
  });

  app.get("/api/stats/:granularity/:date", async (context) => {
    const system = await topology();
    const granularity = context.req.param("granularity");
    const date = context.req.param("date");

    const dateType = granularity === "year" ? 1 : granularity === "month" ? 2 : null;
    if (dateType === null) {
      return context.json({ error: "granularity must be 'year' or 'month'" }, 400);
    }

    const shape = dateType === 1 ? /^\d{4}$/ : /^\d{4}-\d{2}$/;
    if (!shape.test(date)) {
      return context.json(
        { error: dateType === 1 ? "date must be YYYY" : "date must be YYYY-MM" },
        400,
      );
    }

    const result = await cache.fetch(
      `stats:${dateType}:${date}`,
      statsTtl(date, system.utcOffsetMinutes),
      async () =>
        endpoints.getPlantStats({
          plantId: system.plantId,
          dateType: dateType as 1 | 2,
          date,
        }),
    );

    return context.json({
      ...result.value,
      plantEnergyStatDataList: normalizeStatEntries(
        result.value.plantEnergyStatDataList ?? [],
      ),
      stale: result.stale,
    });
  });

  /** Daily and lifetime yield, for the impact figures (CO2, savings). */
  app.get("/api/plant/realtime", async (context) => {
    const system = await topology();
    const result = await cache.fetch("plant:realtime", TTL.alarms, () =>
      endpoints.getPlantRealtime(system.plantId),
    );
    return context.json({ ...result.value, stale: result.stale });
  });

  app.get("/api/alarms", async (context) => {
    const system = await topology();
    const state = context.req.query("state") === "closed" ? 0 : 1;
    const result = await cache.fetch(`alarms:${state}`, TTL.alarms, async () =>
      endpoints.listAlarms({ plantId: system.plantId, alarmState: state }),
    );
    return context.json({ alarms: result.value, stale: result.stale });
  });

  // ---- CFE billing: the half of the picture SolaX cannot see ----------------

  app.get("/api/billing/readings", async (context) => {
    return context.json(await readings.load());
  });

  // Upserts by day: any number of readings per period, one per date.
  app.put("/api/billing/readings", async (context) => {
    const parsed = readingSchema.safeParse(await context.req.json());
    if (!parsed.success) {
      return context.json(
        {
          error: "Invalid reading",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        400,
      );
    }
    return context.json(await readings.upsert(parsed.data));
  });

  app.delete("/api/billing/readings/:takenOn", async (context) => {
    const takenOn = context.req.param("takenOn");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(takenOn)) {
      return context.json({ error: "takenOn must be YYYY-MM-DD" }, 400);
    }
    return context.json(await readings.remove(takenOn));
  });

  /**
   * Closes the open period with the recibo in hand. The cut date's reading must
   * already be saved: it is what the period's figures are computed from.
   */
  app.post("/api/billing/periods/close", async (context) => {
    const parsed = z
      .object({ end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bill: billSchema })
      .safeParse(await context.req.json());
    if (!parsed.success) {
      return context.json(
        { error: "end must be YYYY-MM-DD and bill needs kwh and totalMxn >= 0" },
        400,
      );
    }
    return context.json(await readings.closePeriod(parsed.data.end, parsed.data.bill));
  });

  // Meter-swap facts: unbilled carryover and the day the new meter went in.
  app.on("PUT", ["/api/billing/carryover", "/api/billing/meter"], async (context) => {
    const parsed = z
      .object({
        carryoverKwh: z.number().nonnegative().optional(),
        meterInstalledOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .safeParse(await context.req.json());
    if (!parsed.success) {
      return context.json(
        { error: "carryoverKwh must be >= 0 and meterInstalledOn YYYY-MM-DD" },
        400,
      );
    }
    return context.json(await readings.updateMeter(parsed.data));
  });

  /**
   * The bolsa, the depletion projection and DAC proximity in one call.
   *
   * `dacBasis` is a query parameter because whether CFE averages gross or net
   * billed consumption for the DAC test is unconfirmed, and the answer changes
   * whether solar shields the account at all. The response echoes the basis
   * used so a reader knows which assumption produced the number.
   */
  app.get("/api/billing/summary", async (context) => {
    const file = await readings.load();
    const latestPrices = CFE_1C.summer;
    // Bill history alone is enough for the DAC assessment, so only bail out
    // when there is nothing at all.
    if (file.readings.length === 0 && file.history.length === 0) {
      return context.json({
        periods: [],
        open: null,
        projection: null,
        dac: null,
        savings: null,
        balance: null,
        tariff: { code: CFE_1C.code, verified: latestPrices.verified ?? false },
      });
    }

    // One entry per CLOSED period; the open one only reports running figures.
    const bank = runEnergyBank(file, {
      carryoverKwh: file.carryoverKwh,
      firstReadingIsFreshMeter: true,
    });
    const periods = bank.periods;
    const firstStart = file.periods[0]?.start ?? null;

    /**
     * Closes the energy balance per period.
     *
     * With no battery, `load = PV + imported - exported`, and PV is measured by
     * the inverters. So self-sufficiency, self-consumption and the true house
     * consumption — all uncomputable instantaneously without a meter — are
     * EXACT once a period closes.
     *
     * PV is summed DAY BY DAY between the period's own dates, so generation and
     * meter cover the same window. One `get_stat_data` call returns a month of
     * daily PV; closed months are cached for a month, so this costs a call only
     * for the current month.
     */
    const system = await topology();
    const pvByDay = new Map<string, number>();
    const loadedMonths = new Set<string>();
    async function ensureMonth(month: string): Promise<void> {
      if (loadedMonths.has(month)) return;
      loadedMonths.add(month);
      const entries = await bestEffort(`stats:2:${month}`, async () => {
        const cached = await cache.fetch(`stats:2:${month}`, statsTtl(month, system.utcOffsetMinutes), () =>
          endpoints.getPlantStats({ plantId: system.plantId, dateType: 2, date: month }),
        );
        return cached.value.plantEnergyStatDataList ?? [];
      });
      for (const entry of entries) {
        const kwh = effectivePvKwh(entry);
        if (kwh !== null) pvByDay.set(entry.date, kwh);
      }
    }

    /**
     * The meter-swap carryover is excluded: it is old-meter consumption from
     * before solar, relevant to the bill and the bolsa, not to this balance.
     * The first period counts its start day (the meter went in that morning);
     * later ones start the day after the previous cut, which closed that day.
     */
    async function balanceWindow(window: {
      label: string;
      start: string;
      end: string;
      importedKwh: number;
      exportedKwh: number;
      open: boolean;
    }): Promise<PeriodBalance> {
      const first = window.start === firstStart;
      for (const month of monthsSpanned(window.start, window.end)) await ensureMonth(month);
      let pv = 0;
      for (const [day, kwh] of pvByDay) {
        const inRange = first
          ? day >= window.start && day <= window.end
          : day > window.start && day <= window.end;
        if (inRange) pv += kwh;
      }
      const balance = balancePeriod({
        period: window.label,
        pvGeneratedKwh: pv,
        importedKwh: window.importedKwh - (first ? file.carryoverKwh : 0),
        exportedKwh: window.exportedKwh,
        days: daysBetween(window.start, window.end) + (first ? 1 : 0),
        open: window.open,
      });

      // Days before the first day SolaX recorded production count as zero:
      // on a new install the panels simply were not on yet. Said next to the
      // numbers, so a dongle that joined late would still be noticed.
      const firstDataDay = [...pvByDay.entries()]
        .filter(([, kwh]) => kwh > 0)
        .map(([day]) => day)
        .sort()[0];
      return firstDataDay && window.start < firstDataDay
        ? {
            ...balance,
            note:
              `Generación contada desde el ${firstDataDay}, primer día con datos de ` +
              `SolaX; los días anteriores del periodo cuentan como 0 kWh.`,
          }
        : balance;
    }

    const balances: PeriodBalance[] = [];
    for (const period of periods) {
      balances.push(await balanceWindow({ ...period, open: false }));
    }
    // The open period, up to its latest reading: the only estimate of the
    // house's consumption until the first bill closes.
    const open = bank.open;
    if (open?.lastReadingOn && open.lastReadingOn > open.start) {
      balances.push(await balanceWindow({ ...open, end: open.lastReadingOn, open: true }));
    }

    const trend = summarizeBalances(balances);

    const basis: DacBasis = context.req.query("dacBasis") === "gross" ? "gross" : "billed";

    /**
     * DAC averages the trailing 12 months, so it needs history from BEFORE the
     * new meter. The recibo's "consumo histórico" supplies it; the meter's
     * closed periods extend it forward, each spread over the calendar months
     * its real dates cover, in proportion to the days in each.
     *
     * Merged by month with the bill winning where both cover the same month:
     * the history is what CFE actually billed. Without the de-duplication the
     * month the meter was swapped would be counted twice.
     *
     * Pre-solar history is the same under both bases — with no solar there was
     * nothing to net against.
     */
    const byMonth = new Map<string, number>();
    for (const entry of bimonthlyToMonthly(file.history)) {
      byMonth.set(entry.period, entry.kwh);
    }
    for (const period of periods) {
      const kwh = basis === "gross" ? period.importedKwh : period.billedKwh;
      for (const entry of spreadOverMonths(period.start, period.end, kwh)) {
        if (!byMonth.has(entry.period)) byMonth.set(entry.period, entry.kwh);
      }
    }
    const monthly = [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, kwh]) => ({ period, kwh }));

    // Each bill priced with the prices printed on it, not today's.
    const savings = periods.map((period) => ({
      period: period.period,
      // What the bill would have been without the array, minus what it was.
      amount: savingsFromOffset(
        period.importedKwh,
        period.billedKwh,
        scheduleForPeriodEnd(CFE_1C.summerVersions, period.end),
      ),
    }));

    return context.json({
      periods,
      open,
      projection: projectBankDepletion(periods),
      dac: assessDacRisk(monthly, CFE_1C.dacLimitKwhPerMonth, basis),
      savings,
      balance: trend,
      // Typical gross consumption per bimester from the last year of bills —
      // what solar displaces from, and so what prices each displaced kWh.
      averageBimonthlyKwh:
        file.history.length > 0
          ? file.history.slice(-6).reduce((sum, entry) => sum + entry.kwh, 0) /
            Math.min(6, file.history.length)
          : null,
      currency: CFE_1C.currency,
      tariff: {
        code: CFE_1C.code,
        // Savings and projections use the summer prices, so their
        // verification is what decides whether the peso figures are provisional.
        verified: latestPrices.verified ?? false,
        note: latestPrices.source ?? CFE_1C.provenance.note,
      },
    });
  });

  return app;
}

/** `YYYY-MM` months touched by an inclusive `YYYY-MM-DD` range. */
function monthsSpanned(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ey, em] = to.split("-").map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Splits a period's kWh over the calendar months of its days (`start`
 * exclusive, `end` inclusive), so a 06 AGO – 07 OCT bill weighs on August,
 * September and October as it really did.
 */
function spreadOverMonths(start: string, end: string, kwh: number): { period: string; kwh: number }[] {
  const days = daysBetween(start, end);
  if (days <= 0) return [];
  const perMonth = new Map<string, number>();
  for (let offset = 1; offset <= days; offset++) {
    const month = addDays(start, offset).slice(0, 7);
    perMonth.set(month, (perMonth.get(month) ?? 0) + 1);
  }
  return [...perMonth.entries()].map(([period, count]) => ({ period, kwh: (kwh * count) / days }));
}

/**
 * The one error handler, registered by the entrypoint on the one app.
 *
 * Each failure mode gets a distinguishable response because they need different
 * responses from the client: a budget refusal is retried once its
 * `retryAfterMs` has passed, a bad
 * credential needs a .env fix, and a schema mismatch needs the offending field
 * names — "Internal error" is useless for all three.
 */
export function apiErrorHandler(error: Error, context: Context) {
  // A reading or a period close the stored data cannot accept: the message is
  // written for the person filling in the form.
  if (error instanceof ReadingsError) {
    return context.json({ error: error.message }, 400);
  }

  if (error instanceof RateLimitExceededError) {
    return context.json(
      { error: error.message, scope: error.scope, retryAfterMs: error.retryAfterMs },
      429,
    );
  }

  if (error instanceof SolaxError) {
    const status = error.isQuotaExhausted || error.isRateLimit ? 429 : 502;
    console.error(`[api] SolaX ${error.code}: ${error.message}`);
    return context.json(
      {
        error: error.message,
        solaxCode: error.code,
        traceId: error.traceId,
        retryable: error.retryable,
        // Every caller holds off this long after a 10406, so the client knows
        // when a retry can actually get through.
        ...(error.isRateLimit ? { retryAfterMs: RATE_LIMIT_PENALTY_MS } : {}),
      },
      status,
    );
  }

  // A SolaX response that did not match the schema. Name the fields, because
  // that is the only way to tell which part of their contract moved.
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    console.error("[api] SolaX response failed validation:", JSON.stringify(issues));
    return context.json(
      {
        error:
          "La respuesta de SolaX no coincide con el esquema esperado. " +
          "Revisa los campos listados en issues.",
        issues,
      },
      502,
    );
  }

  console.error("[api] unhandled", error);
  return context.json(
    { error: error.message || "Internal error", kind: error.name },
    500,
  );
}
