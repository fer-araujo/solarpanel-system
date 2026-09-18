/**
 * Pure derivations over a day of power samples. No I/O, no framework.
 *
 * These are the numbers the official app does not digest: it shows kWh in and
 * kWh out, but never what fraction of the house ran on its own roof.
 *
 * Every grid-dependent metric is nullable, because without a meter or CT the
 * grid flow is unknown and so are self-sufficiency, self-consumption and the
 * house load itself. Returning null lets the UI say "no medible" rather than
 * publish a confident zero.
 *
 * Money is deliberately NOT computed here. CFE tariffs are tiered and solar
 * displaces kWh from the top of the bill, so a flat rate misstates savings in
 * both directions. That calculation lives in `core/billing`, against the real
 * block schedule.
 */

export interface DaySample {
  pv: number;
  load: number | null;
  battery: number | null;
  grid: number | null;
}

export interface DaySummary {
  pvKwh: number;
  /** null without grid metering — the load is derived from it. */
  loadKwh: number | null;
  importedKwh: number | null;
  exportedKwh: number | null;
  /** null when no battery is fitted. */
  chargedKwh: number | null;
  dischargedKwh: number | null;
  /** Share of house consumption that never came from the grid, 0-100. */
  selfSufficiency: number | null;
  /** Share of production consumed on site instead of exported, 0-100. */
  selfConsumption: number | null;
  /** kWh produced per kWp installed — the array's own efficiency. */
  specificYield: number | null;
  co2AvoidedKg: number;
  peakPvKw: number;
  /** How many samples carried grid data, so a caller can judge coverage. */
  meteredSamples: number;
  totalSamples: number;
}

/** Mexican grid emission factor, kg CO2 per kWh. */
const GRID_CO2_KG_PER_KWH = 0.423;

function toKwh(watts: number, stepMinutes: number): number {
  return (watts * stepMinutes) / 60 / 1000;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export interface SummarizeDayOptions {
  /** Minutes between samples. */
  stepMinutes: number;
  pvCapacityKwp?: number | null;
}

export function summarizeDay(
  samples: readonly DaySample[],
  options: SummarizeDayOptions,
): DaySummary {
  const { stepMinutes, pvCapacityKwp } = options;

  let pvKwh = 0;
  let loadKwh = 0;
  let importedKwh = 0;
  let exportedKwh = 0;
  let chargedKwh = 0;
  let dischargedKwh = 0;
  let peakPv = 0;
  let meteredSamples = 0;
  let batterySamples = 0;

  for (const sample of samples) {
    pvKwh += toKwh(sample.pv, stepMinutes);
    if (sample.pv > peakPv) peakPv = sample.pv;

    if (sample.grid !== null) {
      meteredSamples += 1;
      if (sample.grid > 0) importedKwh += toKwh(sample.grid, stepMinutes);
      else exportedKwh += toKwh(-sample.grid, stepMinutes);
    }

    if (sample.load !== null) loadKwh += toKwh(sample.load, stepMinutes);

    if (sample.battery !== null) {
      batterySamples += 1;
      if (sample.battery < 0) chargedKwh += toKwh(-sample.battery, stepMinutes);
      else dischargedKwh += toKwh(sample.battery, stepMinutes);
    }
  }

  const metered = meteredSamples > 0;
  const hasBattery = batterySamples > 0;
  const selfConsumedKwh = metered ? Math.max(0, loadKwh - importedKwh) : null;

  return {
    pvKwh: round(pvKwh),
    loadKwh: metered ? round(loadKwh) : null,
    importedKwh: metered ? round(importedKwh) : null,
    exportedKwh: metered ? round(exportedKwh) : null,
    chargedKwh: hasBattery ? round(chargedKwh) : null,
    dischargedKwh: hasBattery ? round(dischargedKwh) : null,
    selfSufficiency:
      selfConsumedKwh !== null && loadKwh > 0
        ? round((selfConsumedKwh / loadKwh) * 100, 1)
        : null,
    selfConsumption:
      metered && pvKwh > 0 ? round(((pvKwh - exportedKwh) / pvKwh) * 100, 1) : null,
    specificYield:
      pvCapacityKwp && pvCapacityKwp > 0 ? round(pvKwh / pvCapacityKwp) : null,
    co2AvoidedKg: round(pvKwh * GRID_CO2_KG_PER_KWH, 1),
    peakPvKw: round(peakPv / 1000),
    meteredSamples,
    totalSamples: samples.length,
  };
}
