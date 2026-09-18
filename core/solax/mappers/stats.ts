import type { PlantEnergyStatDto } from "../dto/plant";

/**
 * Production for a stats bucket, falling back to inverter AC output.
 *
 * Same trap as instantaneous power: microinverters report what they deliver on
 * the AC side, and `pvGeneration` can come back as zero while
 * `inverterACOutputEnergy` holds the real figure. AC output is marginally below
 * DC generation (conversion loss), which is the right side of the error for a
 * savings calculation.
 */
export function effectivePvKwh(entry: PlantEnergyStatDto): number | null {
  const pv = entry.pvGeneration;
  if (pv !== null && pv !== undefined && pv > 0) return pv;
  const ac = entry.inverterACOutputEnergy;
  if (ac !== null && ac !== undefined && ac > 0) return ac;
  return pv ?? ac ?? null;
}

export function normalizeStatEntries(
  entries: readonly PlantEnergyStatDto[],
): PlantEnergyStatDto[] {
  return entries.map((entry) => ({ ...entry, pvGeneration: effectivePvKwh(entry) }));
}
