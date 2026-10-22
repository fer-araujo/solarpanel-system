import { describe, expect, it } from "vitest";
import {
  isIsoDate,
  lastDayOfMonth,
} from "@core/billing/model/calendar";
import {
  averageBimonthlyKwh,
  billHistory,
  monthlyConsumption,
  monthsSpanned,
  spreadOverMonths,
} from "@core/billing/services/consumption";
import type { BankPeriod } from "@core/billing/services/energy-bank";

/** A closed period as the bank reports it; only the fields the series reads matter. */
function closed(start: string, end: string, importedKwh: number, billedKwh: number, billKwh?: number): BankPeriod {
  return {
    period: end.slice(0, 7),
    start,
    end,
    label: "",
    importedKwh,
    exportedKwh: 0,
    netKwh: -importedKwh,
    bankKwh: 0,
    billedKwh,
    expiredKwh: 0,
    ...(billKwh === undefined ? {} : { bill: { kwh: billKwh, totalMxn: 0 } }),
  };
}

describe("calendar dates", () => {
  it.each(["2026-10-07", "2028-02-29", "2026-12-31"])("accepts %s", (date) => {
    expect(isIsoDate(date)).toBe(true);
  });

  it.each(["2026-13-01", "2026-02-31", "2027-02-29", "2026-10-7", "07/10/2026", ""])(
    "rejects %s",
    (date) => {
      expect(isIsoDate(date)).toBe(false);
    },
  );

  it("knows the last day of a month, leap years included", () => {
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastDayOfMonth("2026-02")).toBe("2026-02-28");
    expect(lastDayOfMonth("2026-12")).toBe("2026-12-31");
  });
});

describe("monthsSpanned", () => {
  it("lists every month an inclusive range touches, across a year end", () => {
    expect(monthsSpanned("2026-11-20", "2027-02-03")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });
});

describe("spreadOverMonths", () => {
  it("splits by the days of each month, start exclusive and end inclusive", () => {
    // 16 SEP – 07 OCT: 15 days of September, 7 of October.
    const shares = spreadOverMonths("2026-09-15", "2026-10-07", 2200);
    expect(shares).toEqual([
      { period: "2026-09", kwh: 1500 },
      { period: "2026-10", kwh: 700 },
    ]);
  });

  it("is empty for an empty range", () => {
    expect(spreadOverMonths("2026-09-15", "2026-09-15", 100)).toEqual([]);
  });
});

describe("monthlyConsumption", () => {
  const history = [
    { period: "2026-06", kwh: 1200 },
    { period: "2026-08", kwh: 2000 },
  ];
  // 15 SEP – 07 OCT 26: 1,701 carried over + 435 imported, 1,792 billed.
  const periods = [closed("2026-09-15", "2026-10-07", 2136, 1790, 1792)];

  it("differs by basis for closed periods", () => {
    const gross = monthlyConsumption({ history, periods, basis: "gross" });
    const billed = monthlyConsumption({ history, periods, basis: "billed" });
    const total = (series: { kwh: number }[]) => series.reduce((sum, m) => sum + m.kwh, 0);
    expect(total(gross)).toBeCloseTo(1200 + 2000 + 2136, 6);
    // Billed takes what the recibo printed over the bank's own figure.
    expect(total(billed)).toBeCloseTo(1200 + 2000 + 1792, 6);
  });

  it("lets the meter supersede history in every month a period touches", () => {
    const series = monthlyConsumption({
      // A history row for the same bill (cut in October) must not be counted again.
      history: [...history, { period: "2026-10", kwh: 1792 }],
      periods,
      basis: "gross",
    });
    expect(series.map((m) => m.period)).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    const september = series.find((m) => m.period === "2026-09")?.kwh ?? 0;
    const october = series.find((m) => m.period === "2026-10")?.kwh ?? 0;
    expect(september + october).toBeCloseTo(2136, 6);
  });

  it("adds both shares of a month two periods split", () => {
    const series = monthlyConsumption({
      history: [],
      periods: [
        // 62 and 61 days: 10 kWh a day each.
        closed("2026-08-06", "2026-10-07", 620, 620),
        closed("2026-10-07", "2026-12-07", 610, 610),
      ],
      basis: "billed",
    });
    // October: 7 days of the first (10/day) and 24 of the second (10/day).
    expect(series.find((m) => m.period === "2026-10")?.kwh).toBeCloseTo(310, 6);
  });
});

describe("billHistory", () => {
  it("adds each closed period's recibo, replacing a history row for the same month", () => {
    const rows = billHistory(
      [
        { period: "2026-08", kwh: 2188, amountMxn: 7283 },
        { period: "2026-10", kwh: 1700, amountMxn: 5000 },
      ],
      [
        { start: "2026-09-15", end: "2026-10-07", bill: { kwh: 1792, totalMxn: 5472.38 } },
        { start: "2026-10-07", end: null },
      ],
    );
    expect(rows).toEqual([
      { period: "2026-08", kwh: 2188, amountMxn: 7283 },
      { period: "2026-10", kwh: 1792, amountMxn: 5472.38 },
    ]);
  });

  it("averages the last six bills", () => {
    const rows = [100, 200, 300, 400, 500, 600, 700].map((kwh, i) => ({
      period: `2026-0${i + 1}`,
      kwh,
    }));
    expect(averageBimonthlyKwh(rows)).toBe(450);
    expect(averageBimonthlyKwh([])).toBeNull();
  });
});
