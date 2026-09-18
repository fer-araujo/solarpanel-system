/**
 * Proximity to DAC — the cliff that matters more than any savings figure.
 *
 * CFE compares the trailing 12-month average monthly consumption against the
 * limit for the tariff (850 kWh/month on 1C). Cross it and the subsidy is gone:
 * roughly 6-7 MXN/kWh plus a fixed charge, bills several times larger. Coming
 * back requires the average to fall under the limit again, which takes months.
 *
 * Watching this trend is cheap and the warning is worth real money, which is
 * why it sits in the domain and not in a chart component.
 *
 * OPEN QUESTION, deliberately not assumed: under net metering, it is unclear
 * whether CFE averages GROSS consumption or the NET billed kWh. That choice
 * decides whether solar shields the account from DAC at all, so the caller
 * passes whichever series it means and `basis` records the decision.
 */

export type DacBasis = "gross" | "billed";

export interface MonthlyConsumption {
  /** `YYYY-MM`. */
  period: string;
  kwh: number;
}

export interface DacRisk {
  trailingAverageKwh: number;
  limitKwhPerMonth: number;
  /** Monthly kWh still available before the limit. Negative once exceeded. */
  headroomKwhPerMonth: number;
  /** Share of the limit used, 0-1 and beyond. */
  utilisation: number;
  exceeded: boolean;
  /** True once within 10% of the limit — worth warning before the cliff. */
  approaching: boolean;
  monthsSampled: number;
  basis: DacBasis;
}

const APPROACHING_THRESHOLD = 0.9;
const TRAILING_MONTHS = 12;

export function assessDacRisk(
  history: readonly MonthlyConsumption[],
  limitKwhPerMonth: number,
  basis: DacBasis,
): DacRisk | null {
  if (history.length === 0 || limitKwhPerMonth <= 0) return null;

  const window = history.slice(-TRAILING_MONTHS);
  const trailingAverageKwh =
    window.reduce((sum, month) => sum + month.kwh, 0) / window.length;
  const utilisation = trailingAverageKwh / limitKwhPerMonth;

  return {
    trailingAverageKwh,
    limitKwhPerMonth,
    headroomKwhPerMonth: limitKwhPerMonth - trailingAverageKwh,
    utilisation,
    exceeded: utilisation > 1,
    approaching: utilisation >= APPROACHING_THRESHOLD && utilisation <= 1,
    monthsSampled: window.length,
    basis,
  };
}

/**
 * Spreads a bimonthly bill across the months it covers, so bill-shaped data can
 * feed a limit that is defined per month. Even splitting is an approximation —
 * the real months inside a period are rarely equal — and it is used because the
 * bill gives no finer breakdown.
 */
export function bimonthlyToMonthly(
  periods: readonly { period: string; kwh: number }[],
  monthsPerPeriod = 2,
): MonthlyConsumption[] {
  const out: MonthlyConsumption[] = [];

  for (const entry of periods) {
    const share = entry.kwh / monthsPerPeriod;
    const [yearPart, monthPart] = entry.period.split("-");
    const year = Number(yearPart);
    const month = Number(monthPart);

    // The period is labelled by the month it closes in, so it covers that month
    // and the ones before it.
    for (let back = monthsPerPeriod - 1; back >= 0; back--) {
      const zeroBased = year * 12 + (month - 1) - back;
      const outYear = Math.floor(zeroBased / 12);
      const outMonth = (zeroBased % 12) + 1;
      out.push({
        period: `${outYear}-${String(outMonth).padStart(2, "0")}`,
        kwh: share,
      });
    }
  }

  return out;
}
