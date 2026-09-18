import type { TariffSchedule } from "../model/tariff";

/**
 * Turns kWh into pesos through a tiered schedule.
 *
 * Consumption fills the blocks from the bottom up, which is the whole reason a
 * flat average rate cannot value solar correctly: the kWh a solar array removes
 * come off the TOP of the bill. `savingsFromOffset` exploits that directly
 * instead of approximating it.
 */

export function priceEnergy(kwh: number, schedule: TariffSchedule): number {
  if (kwh < 0) throw new Error(`Cannot price negative consumption (${kwh} kWh)`);

  let remaining = kwh;
  let lowerBound = 0;
  let cost = schedule.fixedCharge;

  for (const block of schedule.blocks) {
    if (remaining <= 0) break;
    const width =
      block.upToKwh === null ? Number.POSITIVE_INFINITY : block.upToKwh - lowerBound;
    const consumed = Math.min(remaining, width);
    cost += consumed * block.pricePerKwh;
    remaining -= consumed;
    if (block.upToKwh !== null) lowerBound = block.upToKwh;
  }

  return cost;
}

/**
 * Price of the next kWh at this consumption level — the number that actually
 * describes what one more (or one fewer) kWh is worth.
 */
export function marginalPricePerKwh(kwh: number, schedule: TariffSchedule): number {
  for (const block of schedule.blocks) {
    if (block.upToKwh === null || kwh < block.upToKwh) return block.pricePerKwh;
  }
  // Only reachable for a schedule with no unbounded block, which
  // assertScheduleWellFormed rejects.
  const last = schedule.blocks[schedule.blocks.length - 1];
  if (!last) throw new Error(`Schedule "${schedule.label}" has no blocks`);
  return last.pricePerKwh;
}

/**
 * What the solar array was actually worth over a billing period: the cost of
 * the bill you would have received minus the cost of the bill you got.
 *
 * Exact, not an estimate. No average rate is involved, so it automatically
 * credits the expensive excedente kWh that solar displaces first.
 */
export function savingsFromOffset(
  grossKwh: number,
  billedKwh: number,
  schedule: TariffSchedule,
): number {
  if (billedKwh > grossKwh) {
    throw new Error(
      `Billed consumption (${billedKwh} kWh) cannot exceed gross consumption (${grossKwh} kWh)`,
    );
  }
  // The fixed charge is present in both terms and cancels, as it should:
  // solar does not remove it.
  return priceEnergy(grossKwh, schedule) - priceEnergy(billedKwh, schedule);
}

export interface BlockBreakdown {
  label: string;
  kwh: number;
  pricePerKwh: number;
  cost: number;
}

/** Per-block split, for showing a bill the way the recibo itself lays it out. */
export function breakdownByBlock(
  kwh: number,
  schedule: TariffSchedule,
): BlockBreakdown[] {
  let remaining = kwh;
  let lowerBound = 0;
  const rows: BlockBreakdown[] = [];

  for (const block of schedule.blocks) {
    if (remaining <= 0) break;
    const width =
      block.upToKwh === null ? Number.POSITIVE_INFINITY : block.upToKwh - lowerBound;
    const consumed = Math.min(remaining, width);
    rows.push({
      label: block.label,
      kwh: consumed,
      pricePerKwh: block.pricePerKwh,
      cost: consumed * block.pricePerKwh,
    });
    remaining -= consumed;
    if (block.upToKwh !== null) lowerBound = block.upToKwh;
  }

  return rows;
}
