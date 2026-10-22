import { daysBetween } from "../model/calendar";
import {
  assertPeriodsUsable,
  assertReadingsUsable,
  expectedEnd,
  monthsBetween,
  periodLabel,
  type BillingPeriod,
  type MeterReading,
  type PeriodBill,
} from "../model/meter-reading";

/**
 * CFE net metering — the "bolsa energética".
 *
 * Surplus exported in one period becomes a credit you draw on later; CFE bills
 * only what the bank cannot cover. The reference spreadsheet models this as a
 * running sum floored at zero:
 *
 *   bruto  = (retorno - retorno_prev) - (consumo - consumo_prev)
 *   bolsa  = IF(bruto + bolsa_prev > 0, bruto + bolsa_prev, 0)
 *   cargo  = IF(bolsa > 0, 0, ABS(MIN(bruto + bolsa_prev, 0)))
 *
 * That running sum is correct only while credits never expire, and they DO:
 * CFE's bolsa runs on a rolling year, so surplus banked in a given month dies
 * at the end of that same month twelve months later. Credits are therefore
 * tracked as dated FIFO lots — oldest spent first, each able to age out.
 *
 * A period is settled only at its CUT DATE, by the reading taken that day.
 * Readings in between are just progress: they feed the open period's running
 * figures and never create a period of their own. (Treating each reading as a
 * period, as an earlier version did, netted and billed every few days.)
 *
 * Setting `creditLifetimeMonths` to null disables expiry, which makes the
 * result arithmetically identical to the spreadsheet; that is how the reference
 * fixture is reproduced, not how a real account behaves.
 */

/**
 * CFE's bolsa runs on a rolling year: surplus banked in a given month expires
 * at the end of that same month twelve months later.
 */
export const CFE_CREDIT_LIFETIME_MONTHS = 12;

export interface EnergyBankOptions {
  /**
   * Unbilled kWh carried over when a meter was replaced — consumption recorded
   * on the old meter that never made it onto a bill. Applied to the first
   * period only. (The spreadsheet's G2.)
   */
  carryoverKwh?: number;
  /**
   * Months a credit survives before aging out. Defaults to CFE's rolling year.
   * null disables expiry entirely (used to reproduce the reference spreadsheet,
   * which does not model it).
   */
  creditLifetimeMonths?: number | null;
  /**
   * True when the first period starts on a freshly installed meter whose
   * registers started at zero, so its closing reading is that period's own
   * total. False when the first period's opening reading is only a baseline to
   * difference against.
   */
  firstReadingIsFreshMeter?: boolean;
}

export interface BankPeriod {
  /**
   * `YYYY-MM` of the cut date. Credits are dated by it (expiry runs by
   * month) and CFE labels the bill by it.
   */
  period: string;
  /** `YYYY-MM-DD` the period started (previous cut date or meter install). */
  start: string;
  /** `YYYY-MM-DD` cut date. */
  end: string;
  /** "ago–oct 26". */
  label: string;
  /** kWh drawn from the grid during the period. */
  importedKwh: number;
  /** kWh returned to the grid during the period. */
  exportedKwh: number;
  /** exported - imported. Positive = built credit. */
  netKwh: number;
  /** Credit remaining after the period settles. */
  bankKwh: number;
  /** kWh CFE actually bills for the period. */
  billedKwh: number;
  /** Credit that aged out at the start of the period. */
  expiredKwh: number;
  /** What the recibo printed, when it was captured. */
  bill?: PeriodBill;
}

/**
 * The period still accumulating. Only running figures: nothing is netted or
 * banked until the cut date, so it never enters the bank history.
 */
export interface OpenPeriod {
  start: string;
  /** Start + one bimester; the real cut date is only known from the bill. */
  expectedEnd: string;
  label: string;
  /** Latest reading inside the period, or null if none was taken yet. */
  lastReadingOn: string | null;
  /** So far, up to `lastReadingOn` (carryover included in the first period). */
  importedKwh: number;
  exportedKwh: number;
  netKwh: number;
  /** Credit available to this period: the last close minus what expires by its cut. */
  bankKwh: number;
  /** What CFE would bill if the period closed at the last reading. */
  billedSoFarKwh: number;
  /** Days from the last reading (or the start) to the expected cut date. */
  remainingDays: number;
}

export interface EnergyBank {
  /** One entry per CLOSED period, oldest first. */
  periods: BankPeriod[];
  open: OpenPeriod | null;
}

interface CreditLot {
  period: string;
  kwh: number;
}

const ZERO: Pick<MeterReading, "importRegister" | "exportRegister"> = {
  importRegister: 0,
  exportRegister: 0,
};

/** Drops lots older than the lifetime at `month`; returns the kWh that died. */
function expire(lots: CreditLot[], month: string, lifetime: number | null): number {
  if (lifetime === null) return 0;
  let expired = 0;
  for (let i = lots.length - 1; i >= 0; i--) {
    const lot = lots[i];
    // Strictly greater: a credit dies at the END of its anniversary month, so
    // it is still spendable during that period. Using >= would burn credit a
    // whole period early.
    if (lot && monthsBetween(lot.period, month) > lifetime) {
      expired += lot.kwh;
      lots.splice(i, 1);
    }
  }
  return expired;
}

export function runEnergyBank(
  input: { periods: readonly BillingPeriod[]; readings: readonly MeterReading[] },
  options: EnergyBankOptions = {},
): EnergyBank {
  const {
    carryoverKwh = 0,
    creditLifetimeMonths = CFE_CREDIT_LIFETIME_MONTHS,
    firstReadingIsFreshMeter = true,
  } = options;

  const readings = [...input.readings].sort((a, b) => a.takenOn.localeCompare(b.takenOn));
  assertReadingsUsable(readings);
  assertPeriodsUsable(input.periods);
  const readingOn = new Map(readings.map((reading) => [reading.takenOn, reading]));

  const periods: BankPeriod[] = [];
  let lots: CreditLot[] = [];
  let open: OpenPeriod | null = null;

  for (const [index, period] of input.periods.entries()) {
    const first = index === 0;
    // Where this period's deltas count from. Every later period starts on the
    // previous cut date, whose reading closed that period.
    const baseline = first
      ? firstReadingIsFreshMeter
        ? ZERO
        : (readings.find((r) => r.takenOn >= period.start) ?? null)
      : (readingOn.get(period.start) ?? null);
    const carryover = first ? carryoverKwh : 0;

    if (period.end === null) {
      // Without a baseline there is nothing to difference yet: zero so far.
      const latest = baseline
        ? (readings.filter((r) => r.takenOn >= period.start).at(-1) ?? null)
        : null;
      const importedKwh =
        (latest && baseline ? latest.importRegister - baseline.importRegister : 0) + carryover;
      const exportedKwh = latest && baseline ? latest.exportRegister - baseline.exportRegister : 0;
      const netKwh = exportedKwh - importedKwh;
      const end = expectedEnd(period);
      // A copy: the open period must not consume credit it has not settled.
      const available = lots.map((lot) => ({ ...lot }));
      expire(available, end.slice(0, 7), creditLifetimeMonths);
      const bankKwh = available.reduce((sum, lot) => sum + lot.kwh, 0);
      open = {
        start: period.start,
        expectedEnd: end,
        label: periodLabel(period),
        lastReadingOn: latest?.takenOn ?? null,
        importedKwh,
        exportedKwh,
        netKwh,
        bankKwh,
        billedSoFarKwh: Math.max(0, -netKwh - bankKwh),
        remainingDays: Math.max(0, daysBetween(latest?.takenOn ?? period.start, end)),
      };
      continue;
    }

    if (!baseline) {
      throw new Error(`No reading on ${period.start} to start the billing period from`);
    }
    const closing = readingOn.get(period.end);
    if (!closing) {
      throw new Error(`Billing period ${periodLabel(period)} has no reading on its cut date ${period.end}`);
    }

    const month = period.end.slice(0, 7);
    const importedKwh = closing.importRegister - baseline.importRegister + carryover;
    const exportedKwh = closing.exportRegister - baseline.exportRegister;
    const expiredKwh = expire(lots, month, creditLifetimeMonths);

    const netKwh = exportedKwh - importedKwh;
    let billedKwh = 0;

    if (netKwh > 0) {
      lots.push({ period: month, kwh: netKwh });
    } else if (netKwh < 0) {
      let deficit = -netKwh;
      while (deficit > 0 && lots.length > 0) {
        const oldest = lots[0];
        if (!oldest) break;
        const drawn = Math.min(oldest.kwh, deficit);
        oldest.kwh -= drawn;
        deficit -= drawn;
        if (oldest.kwh <= 0) lots.shift();
      }
      billedKwh = deficit;
    }
    lots = lots.filter((lot) => lot.kwh > 0);

    periods.push({
      period: month,
      start: period.start,
      end: period.end,
      label: periodLabel(period),
      importedKwh,
      exportedKwh,
      netKwh,
      bankKwh: lots.reduce((sum, lot) => sum + lot.kwh, 0),
      billedKwh,
      expiredKwh,
      ...(period.bill ? { bill: period.bill } : {}),
    });
  }

  return { periods, open };
}

export interface BankProjection {
  /** Credit on hand after the last settled period. */
  bankKwh: number;
  /** Mean net kWh per period over the window used. */
  averageNetKwh: number;
  /** How many periods the current credit covers. null when it is not draining. */
  periodsRemaining: number | null;
  /** Month (`YYYY-MM`) in which billing is expected to resume. null when not draining. */
  depletesAt: string | null;
  /** Closed periods averaged to get here, so a caller can judge the confidence. */
  periodsSampled: number;
}

/**
 * Projects when the bank runs dry, from the recent trend rather than the whole
 * history — consumption is seasonal, so a twelve-month mean hides the swing
 * that actually drains the bank. Counts CLOSED periods only: an open period's
 * figures cover an arbitrary number of days and would skew the average.
 *
 * This answers the question the official app cannot: not "how much credit do I
 * have" but "when do I start paying again".
 */
export function projectBankDepletion(
  periods: readonly BankPeriod[],
  options: { window?: number; periodMonths?: number } = {},
): BankProjection | null {
  const { window = 3, periodMonths = 2 } = options;
  if (periods.length === 0) return null;

  const last = periods[periods.length - 1];
  if (!last) return null;

  const sample = periods.slice(-Math.max(1, window));
  const averageNetKwh =
    sample.reduce((sum, period) => sum + period.netKwh, 0) / sample.length;

  const base = {
    bankKwh: last.bankKwh,
    averageNetKwh,
    periodsSampled: sample.length,
  };

  if (averageNetKwh >= 0) {
    return { ...base, periodsRemaining: null, depletesAt: null };
  }

  const periodsRemaining = last.bankKwh / -averageNetKwh;
  return {
    ...base,
    periodsRemaining,
    depletesAt: addMonths(last.period, Math.ceil(periodsRemaining) * periodMonths),
  };
}

function addMonths(period: string, months: number): string {
  const [yearPart, monthPart] = period.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const zeroBased = year * 12 + (month - 1) + months;
  const outYear = Math.floor(zeroBased / 12);
  const outMonth = (zeroBased % 12) + 1;
  return `${outYear}-${String(outMonth).padStart(2, "0")}`;
}
