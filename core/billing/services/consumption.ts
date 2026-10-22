import { addDays, daysBetween } from "../model/calendar";
import type { BillingPeriod } from "../model/meter-reading";
import { bimonthlyToMonthly, type DacBasis, type MonthlyConsumption } from "./dac-risk";
import type { BankPeriod } from "./energy-bank";

/**
 * Consumption per calendar month and per bill, assembled from the two sources
 * the account has: the recibo's "consumo histórico" from before the new meter,
 * and the meter's own closed periods after it.
 */

/** A row of the recibo's "consumo histórico", labelled by the month it was cut in. */
export interface HistoryRow {
  period: string;
  kwh: number;
  amountMxn?: number;
}

/** `YYYY-MM` months touched by an inclusive `YYYY-MM-DD` range. */
export function monthsSpanned(from: string, to: string): string[] {
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
 * exclusive, `end` inclusive — the start day belongs to the period before), so
 * a 06 AGO – 07 OCT bill weighs on August, September and October as it really
 * did.
 */
export function spreadOverMonths(start: string, end: string, kwh: number): MonthlyConsumption[] {
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
 * The monthly series the DAC average runs on.
 *
 * Closed meter periods are spread over their real days and SUPERSEDE the
 * history for every month they touch: the meter knows gross and billed apart,
 * the recibo's history only knows what was billed. A month shared by two
 * periods gets both shares. History fills only the months no period touches —
 * the years before the new meter — so nothing is counted twice and the gross
 * basis really differs from the billed one.
 *
 * Billed uses what the recibo printed when it was captured, the bank's own
 * figure otherwise.
 */
export function monthlyConsumption(input: {
  history: readonly HistoryRow[];
  periods: readonly BankPeriod[];
  basis: DacBasis;
}): MonthlyConsumption[] {
  const byMonth = new Map<string, number>();
  for (const period of input.periods) {
    const kwh = input.basis === "gross" ? period.importedKwh : (period.bill?.kwh ?? period.billedKwh);
    for (const share of spreadOverMonths(period.start, period.end, kwh)) {
      byMonth.set(share.period, (byMonth.get(share.period) ?? 0) + share.kwh);
    }
  }
  const covered = new Set(byMonth.keys());
  for (const entry of bimonthlyToMonthly(input.history)) {
    if (!covered.has(entry.period)) byMonth.set(entry.period, entry.kwh);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, kwh]) => ({ period, kwh }));
}

/**
 * Every bill on record, for display and averages: the history rows plus the
 * recibo captured when each period was closed. A closed period's own bill
 * replaces a history row for the same cut month.
 */
export function billHistory(
  history: readonly HistoryRow[],
  periods: readonly BillingPeriod[],
): HistoryRow[] {
  const rows = new Map<string, HistoryRow>(history.map((row) => [row.period, row]));
  for (const period of periods) {
    if (period.end === null || !period.bill) continue;
    const month = period.end.slice(0, 7);
    rows.set(month, { period: month, kwh: period.bill.kwh, amountMxn: period.bill.totalMxn });
  }
  return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period));
}

/** Bills that make up "the last year": six bimesters. */
export const BIMESTERS_PER_YEAR = 6;

/** Mean kWh per bill over the last year of bills, or null with none. */
export function averageBimonthlyKwh(rows: readonly HistoryRow[]): number | null {
  const lastYear = rows.slice(-BIMESTERS_PER_YEAR);
  if (lastYear.length === 0) return null;
  return lastYear.reduce((sum, row) => sum + row.kwh, 0) / lastYear.length;
}
