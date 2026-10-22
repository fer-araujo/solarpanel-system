import { describe, expect, it } from "vitest";
import { addDays } from "@core/billing/model/calendar";
import {
  periodLabel,
  type BillingPeriod,
  type MeterReading,
} from "@core/billing/model/meter-reading";
import {
  projectBankDepletion,
  runEnergyBank,
} from "@core/billing/services/energy-bank";

/**
 * Builds contiguous closed periods from one cut-date reading per period, cut
 * on the 6th of each listed month (as the recibo's "08 JUN – 06 AGO"). The
 * first period starts one bimester before its cut.
 */
function closedPeriods(
  rows: { month: string; importRegister: number; exportRegister: number }[],
): { periods: BillingPeriod[]; readings: MeterReading[] } {
  const readings = rows.map((row) => ({
    takenOn: `${row.month}-06`,
    importRegister: row.importRegister,
    exportRegister: row.exportRegister,
  }));
  const periods = readings.map((reading, index) => ({
    start: index === 0 ? addDays(reading.takenOn, -61) : (readings[index - 1]?.takenOn ?? ""),
    end: reading.takenOn,
  }));
  return { periods, readings };
}

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
const SHEET = closedPeriods([
  { month: "2025-11", importRegister: 105, exportRegister: 53 },
  { month: "2026-01", importRegister: 841, exportRegister: 1011 },
  { month: "2026-03", importRegister: 1490, exportRegister: 2288 },
  { month: "2026-05", importRegister: 2468, exportRegister: 3162 },
  { month: "2026-07", importRegister: 3832, exportRegister: 4225 },
]);

const SHEET_CARRYOVER = 936; // G2 = 68158 - 67222, the replaced meter's unbilled kWh

describe("runEnergyBank against the reference spreadsheet", () => {
  const { periods, open } = runEnergyBank(SHEET, {
    carryoverKwh: SHEET_CARRYOVER,
    creditLifetimeMonths: null,
    firstReadingIsFreshMeter: true,
  });

  it("produces one period per closed billing period, and nothing open", () => {
    expect(periods).toHaveLength(5);
    expect(open).toBeNull();
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

describe("billing periods by cut date", () => {
  // This plant: meter in on 15 SEP 26, 1,701 kWh unbilled on the old meter.
  const installed = "2026-09-15";
  const readings: MeterReading[] = [
    { takenOn: "2026-09-18", importRegister: 61, exportRegister: 14 },
    { takenOn: "2026-09-30", importRegister: 290, exportRegister: 180 },
    { takenOn: "2026-10-07", importRegister: 435, exportRegister: 344 },
  ];

  it("keeps several readings in one period as ONE period", () => {
    const bank = runEnergyBank(
      { periods: [{ start: installed, end: "2026-10-07" }], readings },
      { carryoverKwh: 1701 },
    );
    expect(bank.periods).toHaveLength(1);
  });

  it("settles period 1 at its cut reading: 1701 + 435 − 344 = 1792 kWh billed", () => {
    const [period] = runEnergyBank(
      { periods: [{ start: installed, end: "2026-10-07" }], readings },
      { carryoverKwh: 1701 },
    ).periods;
    expect(period).toMatchObject({
      period: "2026-10",
      start: installed,
      end: "2026-10-07",
      importedKwh: 1701 + 435,
      exportedKwh: 344,
      billedKwh: 1792,
      bankKwh: 0,
    });
  });

  it("reports an open period with running figures only", () => {
    const bank = runEnergyBank(
      { periods: [{ start: installed, end: null }], readings: readings.slice(0, 2) },
      { carryoverKwh: 1701 },
    );
    expect(bank.periods).toEqual([]);
    expect(bank.open).toMatchObject({
      start: installed,
      expectedEnd: "2026-11-15",
      lastReadingOn: "2026-09-30",
      importedKwh: 1701 + 290,
      exportedKwh: 180,
      netKwh: 180 - 1991,
      billedSoFarKwh: 1991 - 180,
      remainingDays: 46,
    });
  });

  it("differences the open period against the previous cut, without the carryover", () => {
    const bank = runEnergyBank(
      {
        periods: [
          { start: installed, end: "2026-10-07" },
          { start: "2026-10-07", end: null },
        ],
        readings: [...readings, { takenOn: "2026-10-20", importRegister: 500, exportRegister: 600 }],
      },
      { carryoverKwh: 1701 },
    );
    expect(bank.periods).toHaveLength(1);
    expect(bank.open).toMatchObject({
      start: "2026-10-07",
      importedKwh: 500 - 435,
      exportedKwh: 600 - 344,
      netKwh: 256 - 65,
      billedSoFarKwh: 0,
    });
  });

  it("an open period with no readings yet owes only the carryover", () => {
    const bank = runEnergyBank(
      { periods: [{ start: installed, end: null }], readings: [] },
      { carryoverKwh: 1701 },
    );
    expect(bank.open).toMatchObject({ lastReadingOn: null, importedKwh: 1701, billedSoFarKwh: 1701 });
  });

  it("does not let the open period spend banked credit", () => {
    const bank = runEnergyBank({
      periods: [
        { start: "2026-01-06", end: "2026-03-06" },
        { start: "2026-03-06", end: null },
      ],
      readings: [
        { takenOn: "2026-03-06", importRegister: 0, exportRegister: 500 },
        { takenOn: "2026-04-01", importRegister: 200, exportRegister: 500 },
      ],
    });
    expect(bank.periods[0]?.bankKwh).toBe(500);
    expect(bank.open).toMatchObject({ bankKwh: 500, netKwh: -200, billedSoFarKwh: 0 });
  });

  it("labels periods by their cut dates", () => {
    expect(periodLabel({ start: "2026-08-06", end: "2026-10-07" })).toBe("ago–oct 26");
    expect(periodLabel({ start: "2026-12-05", end: "2027-02-04" })).toBe("dic 26–feb 27");
    // Open: labelled by the expected cut, one bimester on.
    expect(periodLabel({ start: "2026-10-07", end: null })).toBe("oct–dic 26");
  });

  it("refuses a closed period without a reading on its cut date", () => {
    expect(() =>
      runEnergyBank({ periods: [{ start: installed, end: "2026-10-08" }], readings }),
    ).toThrow(/no reading on its cut date/);
  });

  it("refuses periods that are not contiguous", () => {
    expect(() =>
      runEnergyBank({
        periods: [
          { start: installed, end: "2026-10-07" },
          { start: "2026-10-09", end: null },
        ],
        readings,
      }),
    ).toThrow(/not contiguous/);
  });
});

describe("credit expiry", () => {
  const input = closedPeriods([
    // Banks 500 kWh in 2026-01.
    { month: "2026-01", importRegister: 0, exportRegister: 500 },
    // Neutral periods so nothing is spent.
    { month: "2026-03", importRegister: 100, exportRegister: 600 },
    { month: "2027-01", importRegister: 200, exportRegister: 700 },
    { month: "2027-03", importRegister: 300, exportRegister: 800 },
  ]);

  it("keeps a credit alive through its anniversary period", () => {
    const { periods } = runEnergyBank(input, { creditLifetimeMonths: 12 });
    // 2026-01 credit is 12 months old at 2027-01 and dies only at that month's
    // end, so it must still be on the books when 2027-01 settles.
    const anniversary = periods.find((p) => p.period === "2027-01");
    expect(anniversary?.expiredKwh).toBe(0);
  });

  it("expires it in the period after the anniversary", () => {
    const { periods } = runEnergyBank(input, { creditLifetimeMonths: 12 });
    const after = periods.find((p) => p.period === "2027-03");
    expect(after?.expiredKwh).toBe(500);
  });

  it("spends the oldest credit first", () => {
    const fifo = closedPeriods([
      { month: "2026-01", importRegister: 0, exportRegister: 100 },
      { month: "2026-03", importRegister: 0, exportRegister: 400 },
      // Draws 150: should empty the 100 lot then take 50 from the 300 lot.
      { month: "2026-05", importRegister: 150, exportRegister: 400 },
      // A year on, only the 2026-03 lot is old enough to die, and it has 250 left.
      { month: "2027-05", importRegister: 150, exportRegister: 400 },
    ]);
    const { periods } = runEnergyBank(fifo, { creditLifetimeMonths: 12 });

    expect(periods[2]?.bankKwh).toBe(250);
    expect(periods[3]?.expiredKwh).toBe(250);
    expect(periods[3]?.bankKwh).toBe(0);
  });

  it("defaults to CFE's rolling year rather than to never expiring", () => {
    const withDefault = runEnergyBank(input);
    const explicit = runEnergyBank(input, { creditLifetimeMonths: 12 });
    expect(withDefault).toEqual(explicit);
  });
});

describe("input validation", () => {
  it("rejects two readings on the same day", () => {
    expect(() =>
      runEnergyBank({
        periods: [{ start: "2026-01-06", end: null }],
        readings: [
          { takenOn: "2026-02-01", importRegister: 0, exportRegister: 0 },
          { takenOn: "2026-02-01", importRegister: 10, exportRegister: 10 },
        ],
      }),
    ).toThrow(/out of order/);
  });

  it("rejects a register that decreases, which means the meter was swapped", () => {
    expect(() =>
      runEnergyBank(
        closedPeriods([
          { month: "2026-01", importRegister: 500, exportRegister: 500 },
          { month: "2026-03", importRegister: 10, exportRegister: 600 },
        ]),
      ),
    ).toThrow(/backwards/);
  });

  it("treats the first reading as a baseline when the meter is not fresh", () => {
    const { periods } = runEnergyBank(
      {
        periods: [{ start: "2026-01-06", end: "2026-03-06" }],
        readings: [
          { takenOn: "2026-01-06", importRegister: 1000, exportRegister: 2000 },
          { takenOn: "2026-03-06", importRegister: 1200, exportRegister: 2500 },
        ],
      },
      { firstReadingIsFreshMeter: false },
    );
    expect(periods).toHaveLength(1);
    expect(periods[0]?.period).toBe("2026-03");
    expect(periods[0]?.netKwh).toBe(500 - 200);
  });
});

describe("projectBankDepletion", () => {
  it("reports no depletion while the bank is growing", () => {
    const { periods } = runEnergyBank(
      closedPeriods([
        { month: "2026-01", importRegister: 0, exportRegister: 200 },
        { month: "2026-03", importRegister: 50, exportRegister: 500 },
      ]),
    );
    const projection = projectBankDepletion(periods);
    expect(projection?.depletesAt).toBeNull();
    expect(projection?.periodsRemaining).toBeNull();
  });

  it("projects the period in which billing resumes", () => {
    // Bank 400, then drain 200 per period: two periods of runway.
    const { periods } = runEnergyBank(
      closedPeriods([
        { month: "2026-01", importRegister: 0, exportRegister: 400 },
        { month: "2026-03", importRegister: 200, exportRegister: 400 },
        { month: "2026-05", importRegister: 400, exportRegister: 400 },
      ]),
      { creditLifetimeMonths: null },
    );

    const projection = projectBankDepletion(periods, { window: 2 });
    expect(projection?.bankKwh).toBe(0);
    expect(projection?.averageNetKwh).toBe(-200);
    expect(projection?.depletesAt).toBe("2026-05");
  });

  it("averages only the recent window, because consumption is seasonal", () => {
    const { periods } = runEnergyBank(SHEET, {
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
