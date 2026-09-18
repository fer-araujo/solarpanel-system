import type { Watts } from "../model/power";

/**
 * House consumption is derived, never read.
 *
 * The residential SolaX endpoints expose no `loadPower` field — only the EMS
 * (Commercial & Industrial) one does. So the house load has to come out of the
 * energy balance:
 *
 *   pv + battery + grid = load
 *
 * with the normalised convention (positive = into the house). That makes grid
 * metering a hard dependency: with no meter or CT, `grid` is unknown and the
 * load is genuinely unknowable, not zero. Returning null here is what lets the
 * UI say "no medible" instead of drawing a flat line at 0 W and lying.
 */
export function deriveHouseLoad(
  pv: Watts,
  battery: Watts | null,
  grid: Watts | null,
): Watts | null {
  if (grid === null) return null;
  return pv + (battery ?? 0) + grid;
}

/**
 * Splits the load into the three sources that covered it, for the stacked
 * intraday chart. The parts sum to the load, so a viewer can read "this much
 * of my house ran on the roof" straight off the chart.
 */
export interface LoadSources {
  fromPv: Watts;
  fromBattery: Watts;
  fromGrid: Watts;
}

export function splitLoadSources(
  pv: Watts,
  battery: Watts | null,
  grid: Watts | null,
): LoadSources | null {
  const load = deriveHouseLoad(pv, battery, grid);
  if (load === null) return null;

  const fromBattery = Math.max(0, battery ?? 0);
  const fromGrid = Math.max(0, grid ?? 0);
  // Whatever the battery and grid did not cover came straight off the array.
  const fromPv = Math.max(0, load - fromBattery - fromGrid);

  return { fromPv, fromBattery, fromGrid };
}
