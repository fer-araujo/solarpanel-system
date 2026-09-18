import { describe, expect, it } from "vitest";
import type { MeterReading } from "@core/billing/model/meter-reading";
import {
  projectBankDepletion,
  runEnergyBank,
} from "@core/billing/services/energy-bank";

/**
 * Regression fixture from the reference CFE spreadsheet.
 *
 * The numbers are example data, not a real account — their only job is to pin
 * the formulas. Expiry is disabled here because the spreadsheet does not model
 * it; with expiry off the FIFO lot model must be arithmetically identical to
 * the sheet's running sum. If this suite fails, the net metering model drifted.
 *
 * Sheet columns: D = bruto (netKwh), E = bolsa (bankKwh), F = cargo (billedKwh).
 */
const SHEET_READINGS: MeterReading[] = [
  { period: "2025-11", importRegister: 105, exportRegister: 53 },
  { period: "2026-01", importRegister: 841, exportRegister: 1011 },
  { period: "2026-03", importRegister: 1490, exportRegister: 2288 },
  { period: "2026-05", importRegister: 2468, exportRegister: 3162 },
  { period: "2026-07", importRegister: 3832, exportRegister: 4225 },
];

const SHEET_CARRYOVER = 936; // G2 = 68158 - 67222, the replaced meter's unbilled kWh

describe("runEnergyBank against the reference spreadsheet", () => {
  const periods = runEnergyBank(SHEET_READINGS, {
    carryoverKwh: SHEET_CARRYOVER,
    creditLifetimeMonths: null,
    firstReadingIsFreshMeter: true,
  });

  it("produces one period per reading", () => {
    expect(periods).toHaveLength(5);
  });

  it.each([
    ["2025-11", -988, 0, 988],
    ["2026-01", 222, 222, 0],
    ["2026-03", 628, 850, 0],
    ["2026-05", -104, 746, 0],
    ["2026-07", -301, 445, 0],
  ])(
    "%s: net %i kWh, bank %i kWh, billed %i kWh",
    (period, netKwh, bankKwh, billedKwh) => {
      const row = periods.find((p) => p.period === period);
      expect(row).toBeDefined();
      expect(row?.netKwh).toBe(netKwh);
      expect(row?.bankKwh).toBe(bankKwh);
      expect(row?.billedKwh).toBe(billedKwh);
    },
  );

  it("applies the meter-swap carryover to the first period only", () => {
    const first = periods[0];
    // 105 read on the new meter plus 936 unbilled on the old one.
    expect(first?.importedKwh).toBe(1041);
    expect(first?.exportedKwh).toBe(53);

    const second = periods[1];
    expect(second?.importedKwh).toBe(841 - 105);
    expect(second?.exportedKwh).toBe(1011 - 53);
  });

  it("never banks negative credit", () => {
    for (const period of periods) {
      expect(period.bankKwh).toBeGreaterThanOrEqual(0);
    }
  });

  it("bills only what the bank could not cover", () => {
    for (const period of periods) {
      if (period.bankKwh > 0) expect(period.billedKwh).toBe(0);
    }
  });
});

describe("credit expiry", () => {
  const readings: MeterReading[] = [
    // Banks 500 kWh in 2026-01.
    { period: "2026-01", importRegister: 0, exportRegister: 500 },
    // Neutral periods so nothing is spent.
    { period: "2026-03", importRegister: 100, exportRegister: 600 },
    { period: "2027-01", importRegister: 200, exportRegister: 700 },
    { period: "2027-03", importRegister: 300, exportRegister: 800 },
  ];

  it("keeps a credit alive through its anniversary period", () => {
    const periods = runEnergyBank(readings, { creditLifetimeMonths: 12 });
    // 2026-01 credit is 12 months old at 2027-01 and dies only at that month's
    // end, so it must still be on the books when 2027-01 settles.
    const anniversary = periods.find((p) => p.period === "2027-01");
    expect(anniversary?.expiredKwh).toBe(0);
  });

  it("expires it in the period after the anniversary", () => {
    const periods = runEnergyBank(readings, { creditLifetimeMonths: 12 });
    const after = periods.find((p) => p.period === "2027-03");
    expect(after?.expiredKwh).toBe(500);
  });

  it("spends the oldest credit first", () => {
    const fifo: MeterReading[] = [
      { period: "2026-01", importRegister: 0, exportRegister: 100 },
      { period: "2026-03", importRegister: 0, exportRegister: 400 },
      // Draws 150: should empty the 100 lot then take 50 from the 300 lot.
      { period: "2026-05", importRegister: 150, exportRegister: 400 },
      // A year on, only the 2026-03 lot is old enough to die, and it has 250 left.
      { period: "2027-05", importRegister: 150, exportRegister: 400 },
    ];
    const periods = runEnergyBank(fifo, { creditLifetimeMonths: 12 });

    expect(periods[2]?.bankKwh).toBe(250);
    expect(periods[3]?.expiredKwh).toBe(250);
    expect(periods[3]?.bankKwh).toBe(0);
  });

  it("defaults to CFE's rolling year rather than to never expiring", () => {
    const withDefault = runEnergyBank(readings);
    const explicit = runEnergyBank(readings, { creditLifetimeMonths: 12 });
    expect(withDefault).toEqual(explicit);
  });
});

describe("input validation", () => {
  it("rejects readings that go backwards in time", () => {
    expect(() =>
      runEnergyBank([
        { period: "2026-03", importRegister: 0, exportRegister: 0 },
        { period: "2026-01", importRegister: 10, exportRegister: 10 },
      ]),
    ).toThrow(/out of order/);
  });

  it("rejects a register that decreases, which means the meter was swapped", () => {
    expect(() =>
      runEnergyBank([
        { period: "2026-01", importRegister: 500, exportRegister: 500 },
        { period: "2026-03", importRegister: 10, exportRegister: 600 },
      ]),
    ).toThrow(/backwards/);
  });

  it("treats the first reading as a baseline when the meter is not fresh", () => {
    const periods = runEnergyBank(
      [
        { period: "2026-01", importRegister: 1000, exportRegister: 2000 },
        { period: "2026-03", importRegister: 1200, exportRegister: 2500 },
      ],
      { firstReadingIsFreshMeter: false },
    );
    expect(periods).toHaveLength(1);
    expect(periods[0]?.period).toBe("2026-03");
    expect(periods[0]?.netKwh).toBe(500 - 200);
  });
});

describe("projectBankDepletion", () => {
  it("reports no depletion while the bank is growing", () => {
    const periods = runEnergyBank([
      { period: "2026-01", importRegister: 0, exportRegister: 200 },
      { period: "2026-03", importRegister: 50, exportRegister: 500 },
    ]);
    const projection = projectBankDepletion(periods);
    expect(projection?.depletesAt).toBeNull();
    expect(projection?.periodsRemaining).toBeNull();
  });

  it("projects the period in which billing resumes", () => {
    // Bank 400, then drain 200 per period: two periods of runway.
    const periods = runEnergyBank(
      [
        { period: "2026-01", importRegister: 0, exportRegister: 400 },
        { period: "2026-03", importRegister: 200, exportRegister: 400 },
        { period: "2026-05", importRegister: 400, exportRegister: 400 },
      ],
      { creditLifetimeMonths: null },
    );

    const projection = projectBankDepletion(periods, { window: 2 });
    expect(projection?.bankKwh).toBe(0);
    expect(projection?.averageNetKwh).toBe(-200);
    expect(projection?.depletesAt).toBe("2026-05");
  });

  it("averages only the recent window, because consumption is seasonal", () => {
    const periods = runEnergyBank(SHEET_READINGS, {
      carryoverKwh: SHEET_CARRYOVER,
      creditLifetimeMonths: null,
    });
    const projection = projectBankDepletion(periods, { window: 2 });

    // Last two periods: -104 and -301.
    expect(projection?.averageNetKwh).toBe(-202.5);
    expect(projection?.periodsSampled).toBe(2);
    expect(projection?.bankKwh).toBe(445);
    // 445 / 202.5 = 2.19 periods -> rounds up to 3 -> six months on from 2026-07.
    expect(projection?.depletesAt).toBe("2027-01");
  });

  it("returns null with no history", () => {
    expect(projectBankDepletion([])).toBeNull();
  });
});
