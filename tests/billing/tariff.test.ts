import { describe, expect, it } from "vitest";
import { CFE_1C } from "@core/billing/data/cfe-1c";
import {
  assertScheduleWellFormed,
  type TariffSchedule,
} from "@core/billing/model/tariff";
import {
  breakdownByBlock,
  marginalPricePerKwh,
  priceEnergy,
  savingsFromOffset,
} from "@core/billing/services/price-energy";
import {
  assessDacRisk,
  bimonthlyToMonthly,
} from "@core/billing/services/dac-risk";

/** Round numbers so the arithmetic is obvious by inspection. */
const SIMPLE: TariffSchedule = {
  label: "test",
  fixedCharge: 10,
  blocks: [
    { upToKwh: 100, pricePerKwh: 1, label: "bajo" },
    { upToKwh: 300, pricePerKwh: 2, label: "medio" },
    { upToKwh: null, pricePerKwh: 5, label: "excedente" },
  ],
};

describe("priceEnergy", () => {
  it("charges the fixed charge at zero consumption", () => {
    expect(priceEnergy(0, SIMPLE)).toBe(10);
  });

  it("prices inside the first block", () => {
    expect(priceEnergy(50, SIMPLE)).toBe(10 + 50);
  });

  it("fills blocks from the bottom up", () => {
    // 100 at 1 + 100 at 2 = 300, plus the fixed charge.
    expect(priceEnergy(200, SIMPLE)).toBe(10 + 100 + 200);
  });

  it("spills into the unbounded block", () => {
    // 100 at 1 + 200 at 2 + 100 at 5 = 1000, plus the fixed charge.
    expect(priceEnergy(400, SIMPLE)).toBe(10 + 100 + 400 + 500);
  });

  it("is exactly additive across a block boundary", () => {
    expect(priceEnergy(100, SIMPLE) + 2).toBe(priceEnergy(101, SIMPLE));
  });

  it("rejects negative consumption rather than inventing a credit", () => {
    expect(() => priceEnergy(-5, SIMPLE)).toThrow(/negative/);
  });
});

describe("marginalPricePerKwh", () => {
  it.each([
    [0, 1],
    [99, 1],
    [100, 2],
    [299, 2],
    [300, 5],
    [5000, 5],
  ])("at %i kWh the next kWh costs %i", (kwh, price) => {
    expect(marginalPricePerKwh(kwh, SIMPLE)).toBe(price);
  });
});

describe("savingsFromOffset", () => {
  it("values displaced kWh at the top of the bill, not at the average", () => {
    // Gross 400, billed 300: solar removed 100 kWh, all from the 5/kWh block.
    expect(savingsFromOffset(400, 300, SIMPLE)).toBe(500);

    // The naive flat-rate answer would use the average of the gross bill,
    // 1000/400 = 2.5/kWh -> 250, understating the real saving by half.
    const flatRateEstimate = 100 * ((priceEnergy(400, SIMPLE) - 10) / 400);
    expect(flatRateEstimate).toBeLessThan(savingsFromOffset(400, 300, SIMPLE));
  });

  it("is zero when nothing was offset", () => {
    expect(savingsFromOffset(250, 250, SIMPLE)).toBe(0);
  });

  it("does not credit the fixed charge, which solar cannot remove", () => {
    expect(savingsFromOffset(400, 0, SIMPLE)).toBe(priceEnergy(400, SIMPLE) - 10);
  });

  it("rejects a bill larger than gross consumption", () => {
    expect(() => savingsFromOffset(100, 200, SIMPLE)).toThrow(/cannot exceed/);
  });
});

describe("breakdownByBlock", () => {
  it("splits consumption the way a recibo lays it out", () => {
    const rows = breakdownByBlock(400, SIMPLE);
    expect(rows).toEqual([
      { label: "bajo", kwh: 100, pricePerKwh: 1, cost: 100 },
      { label: "medio", kwh: 200, pricePerKwh: 2, cost: 400 },
      { label: "excedente", kwh: 100, pricePerKwh: 5, cost: 500 },
    ]);
  });

  it("sums to the energy part of the bill", () => {
    const rows = breakdownByBlock(400, SIMPLE);
    const total = rows.reduce((sum, row) => sum + row.cost, 0);
    expect(total + SIMPLE.fixedCharge).toBe(priceEnergy(400, SIMPLE));
  });
});

describe("CFE_1C schedules", () => {
  it("are well formed", () => {
    expect(() => assertScheduleWellFormed(CFE_1C.summer)).not.toThrow();
    expect(() => assertScheduleWellFormed(CFE_1C.nonSummer)).not.toThrow();
    expect(() => assertScheduleWellFormed(CFE_1C.dac)).not.toThrow();
  });

  it("carries the DAC limit CFE publishes for 1C", () => {
    expect(CFE_1C.dacLimitKwhPerMonth).toBe(850);
  });

  it("is flagged unverified so no peso figure is trusted yet", () => {
    expect(CFE_1C.provenance.verified).toBe(false);
  });

  it("prices DAC above even the subsidised excedente", () => {
    // The real 1C excedente is 4.016, so DAC is not "double" it — but every
    // kWh still costs more, and the lower blocks disappear entirely.
    const subsidised = marginalPricePerKwh(1000, CFE_1C.summer);
    const dac = marginalPricePerKwh(1000, CFE_1C.dac);
    expect(dac).toBeGreaterThan(subsidised);
  });

  it("has verified summer blocks and says so", () => {
    expect(CFE_1C.summer.verified).toBe(true);
    expect(CFE_1C.nonSummer.verified).toBe(false);
  });
});

describe("reproduces the real bill, period 08 JUN 26 – 06 AGO 26", () => {
  // 2,188 kWh on tariff 1C. The recibo itemises it as below and totals the
  // energy at $6,278.41 before IVA. If this drifts, the tariff table is wrong.
  it("splits 2,188 kWh into the same blocks as the recibo", () => {
    const rows = breakdownByBlock(2188, CFE_1C.summer);
    expect(rows.map((row) => row.kwh)).toEqual([300, 300, 300, 1288]);
  });

  it("prices each block as printed", () => {
    const rows = breakdownByBlock(2188, CFE_1C.summer);
    expect(rows[0]?.cost).toBeCloseTo(303.0, 2);
    expect(rows[1]?.cost).toBeCloseTo(351.3, 2);
    expect(rows[2]?.cost).toBeCloseTo(451.5, 2);
    expect(rows[3]?.cost).toBeCloseTo(5172.6, 1);
  });

  it("matches the energy subtotal to the centavo", () => {
    expect(priceEnergy(2188, CFE_1C.summer)).toBeCloseTo(6278.41, 1);
  });

  it("values each displaced kWh at the excedente while above 900 kWh", () => {
    expect(marginalPricePerKwh(2188, CFE_1C.summer)).toBe(4.016);
    // One fewer kWh saves exactly the excedente price.
    expect(savingsFromOffset(2188, 2187, CFE_1C.summer)).toBeCloseTo(4.016, 3);
  });
});

describe("assertScheduleWellFormed", () => {
  it("rejects a schedule that does not end unbounded", () => {
    expect(() =>
      assertScheduleWellFormed({
        label: "bad",
        fixedCharge: 0,
        blocks: [{ upToKwh: 100, pricePerKwh: 1, label: "only" }],
      }),
    ).toThrow(/unbounded block/);
  });

  it("rejects non-ascending bounds", () => {
    expect(() =>
      assertScheduleWellFormed({
        label: "bad",
        fixedCharge: 0,
        blocks: [
          { upToKwh: 200, pricePerKwh: 1, label: "a" },
          { upToKwh: 100, pricePerKwh: 2, label: "b" },
          { upToKwh: null, pricePerKwh: 3, label: "c" },
        ],
      }),
    ).toThrow(/does not increase/);
  });

  it("rejects an unbounded block in the middle", () => {
    expect(() =>
      assertScheduleWellFormed({
        label: "bad",
        fixedCharge: 0,
        blocks: [
          { upToKwh: null, pricePerKwh: 1, label: "a" },
          { upToKwh: null, pricePerKwh: 2, label: "b" },
        ],
      }),
    ).toThrow(/before the end/);
  });
});

describe("assessDacRisk", () => {
  const months = (kwh: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      period: `2026-${String((i % 12) + 1).padStart(2, "0")}`,
      kwh,
    }));

  it("reports headroom below the limit", () => {
    const risk = assessDacRisk(months(600, 12), 850, "billed");
    expect(risk?.trailingAverageKwh).toBe(600);
    expect(risk?.headroomKwhPerMonth).toBe(250);
    expect(risk?.exceeded).toBe(false);
    expect(risk?.approaching).toBe(false);
  });

  it("warns before the cliff, not after", () => {
    const risk = assessDacRisk(months(800, 12), 850, "billed");
    expect(risk?.approaching).toBe(true);
    expect(risk?.exceeded).toBe(false);
  });

  it("flags an account already over the limit", () => {
    const risk = assessDacRisk(months(900, 12), 850, "billed");
    expect(risk?.exceeded).toBe(true);
    expect(risk?.headroomKwhPerMonth).toBeLessThan(0);
    expect(risk?.approaching).toBe(false);
  });

  it("averages only the trailing twelve months", () => {
    const history = [...months(2000, 6), ...months(500, 12)];
    const risk = assessDacRisk(history, 850, "billed");
    expect(risk?.monthsSampled).toBe(12);
    expect(risk?.trailingAverageKwh).toBe(500);
  });

  it("records which basis was used, since the rule is unconfirmed", () => {
    expect(assessDacRisk(months(600, 3), 850, "gross")?.basis).toBe("gross");
    expect(assessDacRisk(months(600, 3), 850, "billed")?.basis).toBe("billed");
  });

  it("returns null with no history", () => {
    expect(assessDacRisk([], 850, "billed")).toBeNull();
  });
});

describe("bimonthlyToMonthly", () => {
  it("spreads a period across the months it closes", () => {
    expect(bimonthlyToMonthly([{ period: "2026-03", kwh: 600 }])).toEqual([
      { period: "2026-02", kwh: 300 },
      { period: "2026-03", kwh: 300 },
    ]);
  });

  it("crosses a year boundary correctly", () => {
    expect(bimonthlyToMonthly([{ period: "2026-01", kwh: 400 }])).toEqual([
      { period: "2025-12", kwh: 200 },
      { period: "2026-01", kwh: 200 },
    ]);
  });

  it("preserves total energy", () => {
    const periods = [
      { period: "2026-01", kwh: 400 },
      { period: "2026-03", kwh: 600 },
    ];
    const monthly = bimonthlyToMonthly(periods);
    const before = periods.reduce((s, p) => s + p.kwh, 0);
    const after = monthly.reduce((s, m) => s + m.kwh, 0);
    expect(after).toBe(before);
  });
});
