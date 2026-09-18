import {
  assertReadingsUsable,
  monthsBetween,
  type MeterReading,
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
   * True when the first reading comes off a freshly installed meter whose
   * registers started at zero, so its values are that period's own totals.
   * False when the first reading is only a baseline to difference against, and
   * therefore produces no period of its own.
   */
  firstReadingIsFreshMeter?: boolean;
}

export interface BankPeriod {
  period: string;
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
}

interface CreditLot {
  period: string;
  kwh: number;
}

export function runEnergyBank(
  readings: readonly MeterReading[],
  options: EnergyBankOptions = {},
): BankPeriod[] {
  const {
    carryoverKwh = 0,
    creditLifetimeMonths = CFE_CREDIT_LIFETIME_MONTHS,
    firstReadingIsFreshMeter = true,
  } = options;

  assertReadingsUsable(readings);

  const periods: BankPeriod[] = [];
  let lots: CreditLot[] = [];
  let previous: MeterReading | null = null;

  for (const reading of readings) {
    let importedKwh: number;
    let exportedKwh: number;

    if (previous === null) {
      if (!firstReadingIsFreshMeter) {
        // Baseline only — it yields no period of its own.
        previous = reading;
        continue;
      }
      importedKwh = reading.importRegister + carryoverKwh;
      exportedKwh = reading.exportRegister;
    } else {
      importedKwh = reading.importRegister - previous.importRegister;
      exportedKwh = reading.exportRegister - previous.exportRegister;
    }

    let expiredKwh = 0;
    if (creditLifetimeMonths !== null) {
      const surviving: CreditLot[] = [];
      for (const lot of lots) {
        // Strictly greater: a credit dies at the END of its anniversary month,
        // so it is still spendable during that period. Using >= would burn
        // credit a whole period early.
        if (monthsBetween(lot.period, reading.period) > creditLifetimeMonths) {
          expiredKwh += lot.kwh;
        } else {
          surviving.push(lot);
        }
      }
      lots = surviving;
    }

    const netKwh = exportedKwh - importedKwh;
    let billedKwh = 0;

    if (netKwh > 0) {
      lots.push({ period: reading.period, kwh: netKwh });
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

    periods.push({
      period: reading.period,
      importedKwh,
      exportedKwh,
      netKwh,
      bankKwh: lots.reduce((sum, lot) => sum + lot.kwh, 0),
      billedKwh,
      expiredKwh,
    });

    previous = reading;
  }

  return periods;
}

export interface BankProjection {
  /** Credit on hand after the last settled period. */
  bankKwh: number;
  /** Mean net kWh per period over the window used. */
  averageNetKwh: number;
  /** How many periods the current credit covers. null when it is not draining. */
  periodsRemaining: number | null;
  /** Period in which billing is expected to resume. null when not draining. */
  depletesAt: string | null;
  /** Periods averaged to get here, so a caller can judge the confidence. */
  periodsSampled: number;
}

/**
 * Projects when the bank runs dry, from the recent trend rather than the whole
 * history — consumption is seasonal, so a twelve-month mean hides the swing
 * that actually drains the bank.
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
