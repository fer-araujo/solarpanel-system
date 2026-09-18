/**
 * Closes the energy balance for a billing period by combining the two halves of
 * the picture: production measured by the inverters, and grid flow read off the
 * CFE bill.
 *
 * On a system with NO BATTERY every kilowatt-hour has exactly one origin and
 * one destination, so over a completed period:
 *
 *   PV + imported = load + exported
 *
 * PV comes from SolaX at five-minute resolution; imported and exported come
 * from the bimonthly meter readings. The house load therefore falls out
 * EXACTLY:
 *
 *   load = PV + imported - exported
 *
 * This matters more than it looks. Self-sufficiency, self-consumption and
 * savings were all written off as uncomputable on a plant with no meter — and
 * they are, instantaneously. Per completed period they are exact.
 *
 * The limit is honest and worth stating: a period yields ONE number, which
 * constrains the LEVEL of consumption, not its shape through the day. No amount
 * of extra periods lets a bimonthly total reveal what happened at 17:15.
 */

export interface PeriodBalanceInput {
  period: string;
  /** kWh generated, measured by the inverters over the same period. */
  pvGeneratedKwh: number;
  /** kWh drawn from the grid, from the bill. */
  importedKwh: number;
  /** kWh returned to the grid, from the bill. */
  exportedKwh: number;
  /** Days the period spans, when the reading dates are known. */
  days?: number;
}

export interface PeriodBalance {
  period: string;
  pvGeneratedKwh: number;
  importedKwh: number;
  exportedKwh: number;
  /** Exact: PV + imported - exported. */
  loadKwh: number;
  /** Exact: production that never left the property. */
  selfConsumedKwh: number;
  /** Share of consumption covered without the grid, 0-100. */
  selfSufficiency: number | null;
  /** Share of production used on site rather than exported, 0-100. */
  selfConsumption: number | null;
  /**
   * False when the inputs contradict each other — for instance more exported
   * than generated, which cannot happen without storage. Usually a period
   * mismatch between the PV window and the bill window, or a typo.
   */
  consistent: boolean;
  inconsistency: string | null;
  days: number | null;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Tolerance for rounding between two independent measuring devices. */
const TOLERANCE_KWH = 1;

export function balancePeriod(input: PeriodBalanceInput): PeriodBalance {
  const { period, pvGeneratedKwh, importedKwh, exportedKwh } = input;

  const loadKwh = pvGeneratedKwh + importedKwh - exportedKwh;
  const selfConsumedKwh = pvGeneratedKwh - exportedKwh;

  let inconsistency: string | null = null;
  if (exportedKwh > pvGeneratedKwh + TOLERANCE_KWH) {
    inconsistency =
      `Exportaste ${round(exportedKwh)} kWh pero solo generaste ` +
      `${round(pvGeneratedKwh)} kWh. Sin batería eso es imposible: revisa que el ` +
      `periodo del recibo coincida con el de generación.`;
  } else if (loadKwh < -TOLERANCE_KWH) {
    inconsistency =
      `El consumo calculado sale negativo (${round(loadKwh)} kWh), así que las ` +
      `lecturas y la generación no corresponden al mismo periodo.`;
  }

  const consistent = inconsistency === null;

  return {
    period,
    pvGeneratedKwh: round(pvGeneratedKwh),
    importedKwh: round(importedKwh),
    exportedKwh: round(exportedKwh),
    loadKwh: round(loadKwh),
    selfConsumedKwh: round(selfConsumedKwh),
    selfSufficiency:
      consistent && loadKwh > 0
        ? round(Math.min(100, ((loadKwh - importedKwh) / loadKwh) * 100), 1)
        : null,
    selfConsumption:
      consistent && pvGeneratedKwh > 0
        ? round(Math.min(100, (selfConsumedKwh / pvGeneratedKwh) * 100), 1)
        : null,
    consistent,
    inconsistency,
    days: input.days ?? null,
  };
}

export interface BalanceTrend {
  periods: PeriodBalance[];
  /** Periods that closed consistently, and so contribute to the averages. */
  usablePeriods: number;
  averageSelfSufficiency: number | null;
  averageSelfConsumption: number | null;
  /**
   * Mean house consumption per day across the usable periods. This is the ONE
   * parameter a bimonthly total can pin down, and what the instantaneous
   * estimate is scaled from.
   */
  averageDailyLoadKwh: number | null;
  /**
   * How much to trust it. One period is a guess, several is a pattern, and the
   * caller should say which.
   */
  confidence: "none" | "provisional" | "fair" | "good";
}

/**
 * Aggregates the closed periods.
 *
 * Averages are weighted by energy rather than by period, so a long or sunny
 * bimester counts for what it actually contributed instead of being one vote
 * among equals.
 */
export function summarizeBalances(
  balances: readonly PeriodBalance[],
  options: { daysPerPeriod?: number } = {},
): BalanceTrend {
  const { daysPerPeriod = 61 } = options;
  const usable = balances.filter((balance) => balance.consistent);

  if (usable.length === 0) {
    return {
      periods: [...balances],
      usablePeriods: 0,
      averageSelfSufficiency: null,
      averageSelfConsumption: null,
      averageDailyLoadKwh: null,
      confidence: "none",
    };
  }

  const totals = usable.reduce(
    (acc, balance) => ({
      pv: acc.pv + balance.pvGeneratedKwh,
      load: acc.load + balance.loadKwh,
      imported: acc.imported + balance.importedKwh,
      exported: acc.exported + balance.exportedKwh,
    }),
    { pv: 0, load: 0, imported: 0, exported: 0 },
  );

  const confidence =
    usable.length >= 6 ? "good" : usable.length >= 3 ? "fair" : "provisional";

  return {
    periods: [...balances],
    usablePeriods: usable.length,
    averageSelfSufficiency:
      totals.load > 0
        ? round(Math.min(100, ((totals.load - totals.imported) / totals.load) * 100), 1)
        : null,
    averageSelfConsumption:
      totals.pv > 0
        ? round(Math.min(100, ((totals.pv - totals.exported) / totals.pv) * 100), 1)
        : null,
    // Real day counts when the readings are dated, the nominal bimester if not.
    averageDailyLoadKwh: round(
      totals.load /
        Math.max(
          1,
          usable.reduce((sum, balance) => sum + (balance.days ?? daysPerPeriod), 0),
        ),
    ),
    confidence,
  };
}
