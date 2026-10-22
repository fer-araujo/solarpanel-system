/**
 * A reading off the CFE bidirectional meter.
 *
 * This is the one part of the system that cannot come from the SolaX API. The
 * inverter on this install has no CT or meter of its own, so it never sees grid
 * flow; CFE's meter keeps both registers and the numbers arrive on the bill —
 * or off the meter itself, as often as anyone cares to read it.
 *
 * Both fields are CUMULATIVE register readings, not per-period totals. A
 * reading is identified by the DAY it was taken: several may fall inside one
 * billing period, and only the one on the period's cut date closes it.
 */
export interface MeterReading {
  /** The day the registers were read, `YYYY-MM-DD`. */
  takenOn: string;
  /** Cumulative kWh drawn from the grid ("consumo"). */
  importRegister: number;
  /** Cumulative kWh returned to the grid ("retorno"). */
  exportRegister: number;
}

/** What CFE printed on the recibo that closed a period. */
export interface PeriodBill {
  /** kWh billed ("consumo facturado"). */
  kwh: number;
  /** Total to pay, IVA included. */
  totalMxn: number;
  /** Energy subtotal before IVA, when captured. */
  energyMxn?: number;
  ivaMxn?: number;
}

/**
 * A billing period as CFE defines it: from one cut date ("fecha de corte") to
 * the next. The dates come from the recibo, not from the calendar — a period
 * runs 06 AGO – 07 OCT, not August–September — so they are stored, never
 * derived from months.
 *
 * `end: null` is the open period, the one still accumulating. Its expected end
 * is `start + DAYS_PER_BIMESTER`; the real cut date only exists once the bill
 * arrives and the period is closed.
 */
export interface BillingPeriod {
  /** `YYYY-MM-DD`: the previous cut date, or the day the meter went in. */
  start: string;
  /** `YYYY-MM-DD` cut date, or null while the period is open. */
  end: string | null;
  bill?: PeriodBill;
}

/** Nominal length of a CFE bimester, for an open period's expected cut date. */
export const DAYS_PER_BIMESTER = 61;

const DAY_MS = 86_400_000;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The cut date to expect for a period: the real one, or start + one bimester. */
export function expectedEnd(period: BillingPeriod): string {
  return period.end ?? addDays(period.start, DAYS_PER_BIMESTER);
}

/**
 * "ago–oct 26", or "dic 26–feb 27" across a year boundary. An open period is
 * labelled by its expected cut date.
 */
export function periodLabel(period: BillingPeriod): string {
  const end = expectedEnd(period);
  const month = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1] ?? "";
  const year = (date: string) => date.slice(2, 4);
  if (month(period.start) === month(end) && year(period.start) === year(end)) {
    return `${month(end)} ${year(end)}`;
  }
  return year(period.start) === year(end)
    ? `${month(period.start)}–${month(end)} ${year(end)}`
    : `${month(period.start)} ${year(period.start)}–${month(end)} ${year(end)}`;
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
 * Readings must be chronological, one per day, and the registers must not go
 * backwards — a decreasing register means a meter swap, which needs
 * `carryoverKwh` and a fresh baseline rather than a silent subtract. Checking
 * the sorted list checks each reading against BOTH neighbours, so a reading
 * inserted between two others cannot sit above the later one.
 */
export function assertReadingsUsable(readings: readonly MeterReading[]): void {
  for (let i = 1; i < readings.length; i++) {
    const previous = readings[i - 1];
    const current = readings[i];
    if (!previous || !current) continue;

    if (current.takenOn <= previous.takenOn) {
      throw new Error(
        `Readings out of order: "${previous.takenOn}" then "${current.takenOn}"`,
      );
    }
    if (
      current.importRegister < previous.importRegister ||
      current.exportRegister < previous.exportRegister
    ) {
      throw new Error(
        `Meter registers went backwards between "${previous.takenOn}" and "${current.takenOn}". ` +
          `A replaced meter needs a new reading series plus carryoverKwh.`,
      );
    }
  }
}

/**
 * Periods must be contiguous — each starting on the previous cut date — with
 * only the last one open. A gap or an overlap would count the same kWh twice
 * or not at all.
 */
export function assertPeriodsUsable(periods: readonly BillingPeriod[]): void {
  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    if (!period) continue;
    const isLast = i === periods.length - 1;
    if (period.end === null && !isLast) {
      throw new Error(`Only the last billing period may be open (found one from ${period.start})`);
    }
    if (period.end !== null && period.end <= period.start) {
      throw new Error(`Billing period ${period.start} ends on or before it starts (${period.end})`);
    }
    const next = periods[i + 1];
    if (next && next.start !== period.end) {
      throw new Error(
        `Billing periods are not contiguous: one ends ${period.end ?? "open"}, the next starts ${next.start}`,
      );
    }
  }
}
