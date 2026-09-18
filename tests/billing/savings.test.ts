import { describe, expect, it } from "vitest";
import { CFE_1C } from "@core/billing/data/cfe-1c";
import {
  MIN_BILLABLE_KWH_PER_BIMESTER,
  projectBill,
  projectNextBill,
} from "@core/billing/services/savings";

describe("CFE minimum charge", () => {
  it("never projects a zero bill, even when solar covers everything", () => {
    const bill = projectBill(1663, 2500, CFE_1C.summer);
    // 50 kWh at básico 1.010 = $50.50, plus 16% IVA.
    expect(bill.withSolar).toBeCloseTo(50 * 1.01 * 1.16, 2);
    expect(bill.withSolar).toBeGreaterThan(0);
    expect(bill.bankedKwh).toBeCloseTo(2500 - 1663, 6);
  });

  it("is 50 kWh per bimester", () => {
    expect(MIN_BILLABLE_KWH_PER_BIMESTER).toBe(50);
  });
});

describe("projectNextBill", () => {
  it("is dominated by what the open period already owes", () => {
    // 1,748 kWh owed after the meter swap (1,701 of it old-meter carryover),
    // 18 days left, solar slightly above consumption: the remainder nets a
    // little off, but the bill stays in the thousands — not zero.
    const next = projectNextBill({
      billedSoFarKwh: 1748,
      remainingDays: 18,
      grossDailyKwh: 1663 / 61,
      solarDailyKwh: 1745 / 61,
      schedule: CFE_1C.summer,
    });
    expect(next.kwh).toBeGreaterThan(1700);
    expect(next.amount).toBeGreaterThan(5000);
  });

  it("falls back to the minimum, never below it", () => {
    const next = projectNextBill({
      billedSoFarKwh: 0,
      remainingDays: 60,
      grossDailyKwh: 10,
      solarDailyKwh: 40,
      schedule: CFE_1C.summer,
    });
    expect(next.kwh).toBe(50);
  });
});
