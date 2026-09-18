import { describe, expect, it } from "vitest";
import {
  balancePeriod,
  summarizeBalances,
} from "@core/billing/services/period-balance";

/**
 * These pin the claim that the "impossible without a meter" metrics become
 * EXACT once a billing period closes, because production is measured by the
 * inverters and grid flow is read off the bill.
 */

describe("balancePeriod", () => {
  it("derives house consumption exactly from the energy balance", () => {
    // Generated 900, pulled 400 from the grid, pushed 300 back.
    const balance = balancePeriod({
      period: "2026-07",
      pvGeneratedKwh: 900,
      importedKwh: 400,
      exportedKwh: 300,
    });

    // 900 + 400 - 300
    expect(balance.loadKwh).toBe(1000);
    // Production that never left: 900 - 300
    expect(balance.selfConsumedKwh).toBe(600);
  });

  it("computes self-sufficiency and self-consumption", () => {
    const balance = balancePeriod({
      period: "2026-07",
      pvGeneratedKwh: 900,
      importedKwh: 400,
      exportedKwh: 300,
    });

    // 600 of 1000 kWh consumed came from the roof.
    expect(balance.selfSufficiency).toBe(60);
    // 600 of 900 kWh produced stayed home.
    expect(balance.selfConsumption).toBeCloseTo(66.7, 1);
  });

  it("reaches 100% self-sufficiency when nothing was imported", () => {
    const balance = balancePeriod({
      period: "2026-07",
      pvGeneratedKwh: 800,
      importedKwh: 0,
      exportedKwh: 300,
    });
    expect(balance.loadKwh).toBe(500);
    expect(balance.selfSufficiency).toBe(100);
  });

  it("handles a period with no solar at all", () => {
    const balance = balancePeriod({
      period: "2026-01",
      pvGeneratedKwh: 0,
      importedKwh: 700,
      exportedKwh: 0,
    });
    expect(balance.loadKwh).toBe(700);
    expect(balance.selfSufficiency).toBe(0);
    expect(balance.selfConsumption).toBeNull();
  });

  it("flags exporting more than was generated, impossible without storage", () => {
    const balance = balancePeriod({
      period: "2026-07",
      pvGeneratedKwh: 500,
      importedKwh: 100,
      exportedKwh: 900,
    });
    expect(balance.consistent).toBe(false);
    expect(balance.inconsistency).toMatch(/imposible/i);
    expect(balance.selfSufficiency).toBeNull();
  });

  it("tolerates small disagreement between two measuring devices", () => {
    const balance = balancePeriod({
      period: "2026-07",
      pvGeneratedKwh: 500,
      importedKwh: 100,
      // Half a kWh over production: rounding between the meter and inverters.
      exportedKwh: 500.5,
    });
    expect(balance.consistent).toBe(true);
  });

  it("flags a negative load as mismatched periods", () => {
    const balance = balancePeriod({
      period: "2026-07",
      pvGeneratedKwh: 100,
      importedKwh: 0,
      exportedKwh: 150,
    });
    expect(balance.consistent).toBe(false);
  });
});

describe("summarizeBalances", () => {
  const periods = [
    { period: "2026-01", pvGeneratedKwh: 600, importedKwh: 500, exportedKwh: 200 },
    { period: "2026-03", pvGeneratedKwh: 900, importedKwh: 400, exportedKwh: 300 },
    { period: "2026-05", pvGeneratedKwh: 1100, importedKwh: 300, exportedKwh: 500 },
  ].map(balancePeriod);

  it("weights by energy, not by period", () => {
    const trend = summarizeBalances(periods);
    // Totals: pv 2600, imported 1200, exported 1000, load 2800.
    // Self-sufficiency = (2800 - 1200) / 2800.
    expect(trend.averageSelfSufficiency).toBeCloseTo(57.1, 1);
    // Self-consumption = (2600 - 1000) / 2600.
    expect(trend.averageSelfConsumption).toBeCloseTo(61.5, 1);
  });

  it("reports average daily consumption, the one figure a bill can pin down", () => {
    const trend = summarizeBalances(periods, { daysPerPeriod: 60 });
    // 2800 kWh over 3 periods of 60 days.
    expect(trend.averageDailyLoadKwh).toBeCloseTo(15.56, 1);
  });

  it("grows in confidence as periods accumulate", () => {
    expect(summarizeBalances([]).confidence).toBe("none");
    expect(summarizeBalances(periods.slice(0, 1)).confidence).toBe("provisional");
    expect(summarizeBalances(periods).confidence).toBe("fair");
    expect(
      summarizeBalances([...periods, ...periods]).confidence,
    ).toBe("good");
  });

  it("excludes inconsistent periods from the averages but keeps them visible", () => {
    const broken = balancePeriod({
      period: "2026-07",
      pvGeneratedKwh: 10,
      importedKwh: 0,
      exportedKwh: 900,
    });
    const trend = summarizeBalances([...periods, broken]);

    expect(trend.usablePeriods).toBe(3);
    expect(trend.periods).toHaveLength(4);
    // The broken period must not drag the average.
    expect(trend.averageSelfSufficiency).toBeCloseTo(57.1, 1);
  });

  it("returns nulls rather than guesses with nothing usable", () => {
    const trend = summarizeBalances([]);
    expect(trend.averageSelfSufficiency).toBeNull();
    expect(trend.averageDailyLoadKwh).toBeNull();
  });
});
