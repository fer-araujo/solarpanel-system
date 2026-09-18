import type { TariffSchedule } from "../model/tariff";
import { priceEnergy } from "./price-energy";

/** IVA applied on top of the energy charge on every CFE residential bill. */
export const IVA_RATE = 0.16;

/**
 * What one solar kWh is worth, in pesos including IVA, over a bimester.
 *
 * Under net metering every solar kWh displaces a kWh from the bill — either
 * directly, or later via the bolsa. And the bill is priced from the top block
 * down, so the first displaced kWh save the excedente (4.016 on 1C) and the
 * later ones only the cheaper blocks beneath it:
 *
 *   value = [price(gross) - price(gross - solar)] / solar × (1 + IVA)
 *
 * Solar beyond gross consumption is valued at ZERO here: it lands in the bolsa,
 * where it only pays off if consumed within 12 months, and otherwise expires.
 * That is deliberately conservative — and it exposes a real risk on an array
 * that out-produces the house.
 *
 * A flat "kWh × 4 pesos" (what the vendor app shows) overstates savings as soon
 * as solar pushes the bill below the excedente block, and ignores IVA.
 */
export function valuePerSolarKwh(
  grossBimonthlyKwh: number,
  solarBimonthlyKwh: number,
  schedule: TariffSchedule,
  ivaRate: number = IVA_RATE,
): number {
  if (solarBimonthlyKwh <= 0 || grossBimonthlyKwh <= 0) return 0;
  const offset = Math.min(solarBimonthlyKwh, grossBimonthlyKwh);
  const saved =
    priceEnergy(grossBimonthlyKwh, schedule) -
    priceEnergy(grossBimonthlyKwh - offset, schedule);
  return (saved / solarBimonthlyKwh) * (1 + ivaRate);
}

export interface BillProjection {
  /** What the bill would be with no solar, IVA included. */
  withoutSolar: number;
  /** What it should be with solar netted against consumption, IVA included. */
  withSolar: number;
  saved: number;
  /** Solar beyond consumption: goes to the bolsa, expires in 12 months if unused. */
  bankedKwh: number;
}

/**
 * The same bimester, with and without the panels.
 *
 * Energy charge only (the bill's other lines are informational market costs).
 * Solar beyond gross consumption is shown as banked, not as money — it only
 * becomes money if a later bimester consumes it within twelve months.
 */
/**
 * CFE never bills zero: residential accounts pay at least 25 kWh a month, i.e.
 * 50 kWh per bimester at the básico price ($50.50 on 1C, before IVA) — even
 * when solar covers everything.
 */
export const MIN_BILLABLE_KWH_PER_BIMESTER = 50;

export function billableKwh(netKwh: number): number {
  return Math.max(MIN_BILLABLE_KWH_PER_BIMESTER, netKwh);
}

export function projectBill(
  grossBimonthlyKwh: number,
  solarBimonthlyKwh: number,
  schedule: TariffSchedule,
  ivaRate: number = IVA_RATE,
): BillProjection {
  const withoutSolar = priceEnergy(billableKwh(grossBimonthlyKwh), schedule) * (1 + ivaRate);
  const net = Math.max(0, grossBimonthlyKwh - solarBimonthlyKwh);
  const withSolar = priceEnergy(billableKwh(net), schedule) * (1 + ivaRate);
  return {
    withoutSolar,
    withSolar,
    saved: withoutSolar - withSolar,
    bankedKwh: Math.max(0, solarBimonthlyKwh - grossBimonthlyKwh),
  };
}

/**
 * Expected production per bimester from installed capacity.
 * Monterrey averages ~5 peak-sun hours a day across the year; 80% covers
 * inverter, temperature, soiling and wiring losses.
 */
export const PEAK_SUN_HOURS = 5;
export const PERFORMANCE_RATIO = 0.8;
export function expectedBimonthlySolarKwh(capacityKwp: number): number {
  return capacityKwp * PEAK_SUN_HOURS * PERFORMANCE_RATIO * DAYS_PER_BIMESTER;
}

export interface NextBillInput {
  /** kWh the current period already owes (carryover + new meter so far). */
  billedSoFarKwh: number;
  /** Days left until the period closes. */
  remainingDays: number;
  /** Typical daily consumption for this season (same bimester last year). */
  grossDailyKwh: number;
  /** Expected daily production. */
  solarDailyKwh: number;
  schedule: TariffSchedule;
}

/**
 * The bill that is actually coming, not a typical one.
 *
 * Starts from what the meter already shows for the open period — which on the
 * first period after a meter swap is dominated by the old meter's carryover —
 * then adds the remaining days at (consumption − solar). Within one period the
 * meter nets import against export, so a negative remainder offsets, but never
 * below CFE's minimum. One-off charges (e.g. meter installation) are NOT
 * included: the amount is not known.
 */
export function projectNextBill(input: NextBillInput): { kwh: number; amount: number } {
  const { billedSoFarKwh, remainingDays, grossDailyKwh, solarDailyKwh, schedule } = input;
  const remainder = Math.max(0, remainingDays) * (grossDailyKwh - solarDailyKwh);
  const kwh = billableKwh(Math.max(0, billedSoFarKwh + remainder));
  return { kwh, amount: priceEnergy(kwh, schedule) * (1 + IVA_RATE) };
}

/** Days in a CFE bimester, for scaling a daily figure to a billing period. */
export const DAYS_PER_BIMESTER = 61;

/**
 * Estimated savings for a day's production, assuming the day is typical of its
 * bimester (production scaled ×61 to price it against the bill).
 */
export function estimateDailySavings(
  dailySolarKwh: number,
  grossBimonthlyKwh: number,
  schedule: TariffSchedule,
): { amount: number; perKwh: number } {
  const perKwh = valuePerSolarKwh(
    grossBimonthlyKwh,
    dailySolarKwh * DAYS_PER_BIMESTER,
    schedule,
  );
  return { amount: dailySolarKwh * perKwh, perKwh };
}
