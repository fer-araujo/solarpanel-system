import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { SUMMER_AGO_OCT_26 } from "@core/billing/data/cfe-1c";
import { savingsFromOffset } from "@core/billing/services/price-energy";
import { apiErrorHandler, registerApiRoutes } from "../../server/app";
import { ReadingsStore } from "../../server/billing/readings-store";
import { loadEnv } from "../../server/env";
import { TtlCache } from "../../server/solax/cache";
import type { SolaxEndpoints } from "../../server/solax/endpoints";
import { RateLimitExceededError } from "../../server/solax/rate-limiter";
import type { BillingSummaryResponse } from "../../src/api/client";

/**
 * The summary route end to end, with SolaX stubbed: what it assembles from the
 * stored periods and the daily PV, not the arithmetic itself (core has its own
 * tests for that).
 */

/** This plant after closing its first period: meter in 15 SEP, cut 07 OCT. */
const FILE = {
  version: 2,
  carryoverKwh: 1701,
  meterInstalledOn: "2026-09-15",
  periods: [
    { start: "2026-09-15", end: "2026-10-07", bill: { kwh: 1792, totalMxn: 5472.38 } },
    { start: "2026-10-07", end: null },
  ],
  readings: [
    { takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 },
    { takenOn: "2026-10-07", importRegister: 435, exportRegister: 344 },
    { takenOn: "2026-10-20", importRegister: 520, exportRegister: 420 },
  ],
  history: [
    { period: "2026-06", kwh: 1377, amountMxn: 3483 },
    { period: "2026-08", kwh: 2188, amountMxn: 7283 },
  ],
};

const PV_PER_DAY = 30;

/** Every day of a `YYYY-MM` month at a flat PV figure. */
function monthOfPv(month: string) {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const days = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => ({
    date: `${month}-${String(i + 1).padStart(2, "0")}`,
    pvGeneration: PV_PER_DAY,
  }));
}

async function summaryApp(getPlantStats: (query: { date: string }) => Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "solar-summary-"));
  await writeFile(join(dir, "cfe-readings.json"), JSON.stringify(FILE), "utf8");
  const endpoints = {
    listPlants: async () => [{ plantId: "p1", plantName: "Test", plantTimeZone: null }],
    listInverters: async () => [],
    listBatteries: async () => [],
    listMeters: async () => [],
    listEvChargers: async () => [],
    getInverterRealtime: async () => [],
    getPlantStats,
  } as unknown as SolaxEndpoints;

  const app = new Hono();
  registerApiRoutes(app, {
    env: loadEnv({
      SOLAX_BASE_URL: "https://example.test",
      SOLAX_CLIENT_ID: "id",
      SOLAX_CLIENT_SECRET: "secret",
      SOLAX_BUSINESS_TYPE: "1",
    } as NodeJS.ProcessEnv),
    endpoints,
    http: {} as never,
    tokenStore: {} as never,
    cache: new TtlCache(),
    readings: new ReadingsStore(dir),
  });
  app.onError(apiErrorHandler);
  return {
    summary: async (basis = "billed") => {
      const response = await app.request(`/api/billing/summary?dacBasis=${basis}`);
      expect(response.status).toBe(200);
      return (await response.json()) as BillingSummaryResponse;
    },
  };
}

const allMonths = async ({ date }: { date: string }) => ({ plantEnergyStatDataList: monthOfPv(date) });

describe("GET /api/billing/summary", () => {
  it("balances the closed period by its dates, counting the start day", async () => {
    const { summary } = await summaryApp(allMonths);
    const [closed] = (await summary()).balance?.periods ?? [];
    // 15 SEP – 07 OCT inclusive: 23 days of PV. Carryover excluded.
    expect(closed).toMatchObject({
      days: 23,
      pvGeneratedKwh: 23 * PV_PER_DAY,
      importedKwh: 435,
      exportedKwh: 344,
      loadKwh: 23 * PV_PER_DAY + 435 - 344,
      open: false,
      partial: false,
      consistent: true,
    });
  });

  it("adds the open period's running balance up to its last reading", async () => {
    const { summary } = await summaryApp(allMonths);
    const result = await summary();
    expect(result.open).toMatchObject({ start: "2026-10-07", lastReadingOn: "2026-10-20" });
    const running = result.balance?.periods.find((balance) => balance.open);
    // 08–20 OCT: 13 days, after the cut day that belongs to the closed period.
    expect(running).toMatchObject({
      days: 13,
      pvGeneratedKwh: 13 * PV_PER_DAY,
      importedKwh: 520 - 435,
      exportedKwh: 420 - 344,
    });
    expect(result.balance?.usablePeriods).toBe(1);
  });

  it("averages DAC on gross and billed differently", async () => {
    const { summary } = await summaryApp(allMonths);
    const billed = (await summary("billed")).dac;
    const gross = (await summary("gross")).dac;
    // May–Aug from the recibo history, Sep–Oct from the closed period.
    expect(billed?.monthsSampled).toBe(6);
    expect(billed?.trailingAverageKwh).toBeCloseTo((1377 + 2188 + 1792) / 6, 6);
    expect(gross?.trailingAverageKwh).toBeCloseTo((1377 + 2188 + 1701 + 435) / 6, 6);
  });

  it("prices savings with the tariff in force at the cut", async () => {
    const { summary } = await summaryApp(allMonths);
    const [saving] = (await summary()).savings ?? [];
    expect(saving?.period).toBe("2026-10");
    expect(saving?.amount).toBeCloseTo(savingsFromOffset(2136, 1792, SUMMER_AGO_OCT_26), 6);
    // All 344 displaced kWh sit in the excedente at 4.041.
    expect(saving?.amount).toBeCloseTo(344 * 4.041, 6);
  });

  it("marks windows partial when SolaX refuses their PV, and recovers later", async () => {
    let refuse = true;
    const getPlantStats = vi.fn(async ({ date }: { date: string }) => {
      if (refuse && date === "2026-10") throw new RateLimitExceededError("minute", 30_000);
      return { plantEnergyStatDataList: monthOfPv(date) };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { summary } = await summaryApp(getPlantStats);

    const degraded = (await summary()).balance;
    expect(degraded?.partial).toBe(true);
    expect(degraded?.periods.every((balance) => balance.partial)).toBe(true);
    // No verdict and no averages from a hole in the data.
    expect(degraded?.periods.every((balance) => balance.inconsistency === null)).toBe(true);
    expect(degraded?.averageDailyLoadKwh).toBeNull();
    // Asked once per request, not retried against the refusal.
    expect(getPlantStats.mock.calls.filter(([q]) => q.date === "2026-10")).toHaveLength(1);

    refuse = false;
    const recovered = (await summary()).balance;
    expect(recovered?.partial).toBe(false);
    expect(recovered?.periods[0]?.pvGeneratedKwh).toBe(23 * PV_PER_DAY);
    warn.mockRestore();
  });
});
