/**
 * CFE residential tariff model.
 *
 * Mexican residential tariffs are TIERED, not flat. Consumption is priced from
 * the bottom block upwards, which has a consequence that matters for every
 * savings figure in this app: the kWh solar removes come off the TOP of the
 * bill, so what you save per kWh is the marginal block price, not the average.
 * A flat rate misstates savings in both directions depending on consumption.
 *
 * Nothing here is hardcoded as truth. Prices and block widths change by period
 * and region, so a schedule carries its own provenance and is meant to be
 * corrected against an actual bill.
 */

export interface TariffBlock {
  /**
   * Upper bound of this block, in kWh for the billing period.
   * `null` marks the final unbounded block (excedente).
   */
  upToKwh: number | null;
  pricePerKwh: number;
  label: string;
}

export interface TariffSchedule {
  label: string;
  /** Ascending by `upToKwh`, final entry unbounded. */
  blocks: readonly TariffBlock[];
  /** Fixed charge per period, if the schedule has one. */
  fixedCharge: number;
  /**
   * True once block widths and prices were copied from a real bill rather than
   * a secondary source. Peso figures computed from an unverified schedule are
   * labelled provisional in the UI.
   */
  verified?: boolean;
  /** Where the numbers came from, e.g. the bill period they were read off. */
  source?: string;
}

/**
 * A schedule as printed on one recibo. CFE adjusts prices every period, so a
 * bill must be priced with the prices in force when it was cut, not today's.
 */
export interface TariffVersion extends TariffSchedule {
  /**
   * `YYYY-MM-DD`: first day of the billing period whose recibo printed these
   * prices (the previous cut date).
   *
   * They apply to every period cut STRICTLY AFTER this day. Strict because
   * a cut date is shared: the JUN–AGO bill is cut on 06 AGO, the very day the
   * AGO–OCT period (and its prices) starts, and it was priced with the old ones.
   */
  periodStart: string;
}

export interface Tariff {
  code: string;
  currency: string;
  /** The latest summer prices: what forward-looking estimates use. */
  summer: TariffSchedule;
  /** Every captured summer price set, oldest first. */
  summerVersions: readonly TariffVersion[];
  nonSummer: TariffSchedule;
  /**
   * Trailing 12-month average consumption, in kWh per month, above which CFE
   * moves the account to DAC. Crossing it removes the subsidy entirely.
   */
  dacLimitKwhPerMonth: number;
  dac: TariffSchedule;
  /** Where these numbers came from, so a stale schedule is visible as stale. */
  provenance: {
    source: string;
    note: string;
    verified: boolean;
  };
}

function byPeriodStart(versions: readonly TariffVersion[]): TariffVersion[] {
  const sorted = [...versions].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
  if (sorted.length === 0) throw new Error("No tariff versions to choose from");
  return sorted;
}

/** The most recent prices on record: what estimates of the future use. */
export function latestVersion(versions: readonly TariffVersion[]): TariffVersion {
  const sorted = byPeriodStart(versions);
  return sorted[sorted.length - 1] as TariffVersion;
}

/**
 * The prices that applied to a period cut on `end` (`YYYY-MM-DD`): the latest
 * version whose period started strictly before that cut. A cut before every
 * known version falls back to the oldest, the closest thing on record.
 */
export function scheduleForPeriodEnd(
  versions: readonly TariffVersion[],
  end: string,
): TariffVersion {
  const sorted = byPeriodStart(versions);
  return sorted.filter((version) => version.periodStart < end).at(-1) ?? (sorted[0] as TariffVersion);
}

export function isBlockUnbounded(block: TariffBlock): boolean {
  return block.upToKwh === null;
}

/**
 * Validates the shape a pricing walk depends on: ascending bounds and exactly
 * one unbounded block, last. A malformed schedule silently produces wrong money
 * figures, so it fails loudly at construction instead.
 */
export function assertScheduleWellFormed(schedule: TariffSchedule): void {
  const { blocks, label } = schedule;
  if (blocks.length === 0) {
    throw new Error(`Tariff schedule "${label}" has no blocks`);
  }

  let previousBound = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) throw new Error(`Tariff schedule "${label}" block ${i} missing`);
    if (block.pricePerKwh < 0) {
      throw new Error(`Tariff schedule "${label}" block "${block.label}" has a negative price`);
    }

    const isLast = i === blocks.length - 1;
    if (block.upToKwh === null) {
      if (!isLast) {
        throw new Error(
          `Tariff schedule "${label}" has an unbounded block "${block.label}" before the end`,
        );
      }
      continue;
    }

    if (isLast) {
      throw new Error(`Tariff schedule "${label}" must end in an unbounded block`);
    }
    if (block.upToKwh <= previousBound) {
      throw new Error(
        `Tariff schedule "${label}" block "${block.label}" does not increase past ${previousBound} kWh`,
      );
    }
    previousBound = block.upToKwh;
  }
}
