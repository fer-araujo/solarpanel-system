/**
 * A bimonthly reading off the CFE bidirectional meter.
 *
 * This is the one part of the system that cannot come from the SolaX API. The
 * inverter on this install has no CT or meter of its own, so it never sees grid
 * flow; CFE's meter keeps both registers and the numbers arrive on the bill.
 * Hence: manual input, roughly six rows a year.
 *
 * Both fields are CUMULATIVE register readings, not per-period totals. Periods
 * are derived by differencing consecutive readings, which is why the order of
 * the list matters and why a missed reading creates a gap rather than an error.
 */
export interface MeterReading {
  /** Billing period the reading belongs to, `YYYY-MM`. */
  period: string;
  /** Cumulative kWh drawn from the grid ("consumo"). */
  importRegister: number;
  /** Cumulative kWh returned to the grid ("retorno"). */
  exportRegister: number;
  /**
   * The exact day the registers were read, `YYYY-MM-DD`. Needed to line the
   * meter window up with daily PV — without it the energy balance is skipped.
   */
  takenOn?: string;
}

/** Whole months from `from` to `to`, both `YYYY-MM`. */
export function monthsBetween(from: string, to: string): number {
  const a = parsePeriod(from);
  const b = parsePeriod(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

export function parsePeriod(period: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) {
    throw new Error(`Invalid period "${period}", expected YYYY-MM`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month in period "${period}"`);
  }
  return { year, month };
}

/**
 * Readings must be chronological for the differencing to mean anything, and the
 * registers must not go backwards — a decreasing register means a meter swap,
 * which needs `carryoverKwh` and a fresh baseline rather than a silent subtract.
 */
export function assertReadingsUsable(readings: readonly MeterReading[]): void {
  for (let i = 1; i < readings.length; i++) {
    const previous = readings[i - 1];
    const current = readings[i];
    if (!previous || !current) continue;

    if (monthsBetween(previous.period, current.period) <= 0) {
      throw new Error(
        `Readings out of order: "${previous.period}" then "${current.period}"`,
      );
    }
    if (
      current.importRegister < previous.importRegister ||
      current.exportRegister < previous.exportRegister
    ) {
      throw new Error(
        `Meter registers went backwards between "${previous.period}" and "${current.period}". ` +
          `A replaced meter needs a new reading series plus carryoverKwh.`,
      );
    }
  }
}
