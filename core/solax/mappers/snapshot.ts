import { deriveHouseLoad } from "../../energy/services/derive-load";
import type {
  BatteryState,
  InverterState,
  PowerSnapshot,
  PvStringReading,
} from "../../energy/model/power";
import {
  INVERTER_STATUS,
  type BatteryRealtimeDto,
  type InverterRealtimeDto,
} from "../dto/device";
import {
  finite,
  normaliseBatteryPower,
  normaliseGridPower,
  parsePlantLocalTime,
  sumMpptMapPower,
  sumPvMapPower,
  toWatts,
  type BusinessType,
} from "./units";

/**
 * Where a production figure was actually read from, in descending fidelity.
 *
 * Surfaced rather than hidden because the fallbacks are not equivalent: the DC
 * sources measure what the panels produced, while the AC ones measure what left
 * the inverter, which is lower by the conversion loss. A reader comparing
 * against the official app deserves to know which one they are looking at.
 */
export type PvSource =
  | "mpptTotal"
  | "pvMap"
  | "mpptMap"
  | "acTotal"
  | "acPhases"
  | "none";

/**
 * Resolves instantaneous production from whichever field the hardware fills.
 *
 * `MPPTTotalInputPower` is the documented answer but arrives null even in
 * SolaX's own example, and a microinverter naturally reports its AC output
 * rather than a DC MPPT total. Reading one field and defaulting to zero made a
 * producing array look asleep, so every documented source is tried in order.
 */
export function resolvePvWatts(
  inverter: InverterRealtimeDto,
  businessType: BusinessType,
): { watts: number; source: PvSource } {
  const mpptTotal = toWatts(inverter.MPPTTotalInputPower, businessType);
  if (mpptTotal !== null && mpptTotal > 0) {
    return { watts: mpptTotal, source: "mpptTotal" };
  }

  const fromPvMap = sumPvMapPower(inverter.pvMap, businessType);
  if (fromPvMap !== null && fromPvMap > 0) {
    return { watts: fromPvMap, source: "pvMap" };
  }

  const fromMpptMap = sumMpptMapPower(inverter.mpptMap, businessType);
  if (fromMpptMap !== null && fromMpptMap > 0) {
    return { watts: fromMpptMap, source: "mpptMap" };
  }

  // AC side from here down: what left the inverter, not what the panels made.
  const acTotal = toWatts(inverter.totalActivePower, businessType);
  if (acTotal !== null && acTotal > 0) {
    return { watts: acTotal, source: "acTotal" };
  }

  const phases = [inverter.acPower1, inverter.acPower2, inverter.acPower3]
    .map((value) => toWatts(value, businessType))
    .filter((value): value is number => value !== null);
  if (phases.length > 0) {
    const sum = phases.reduce((total, value) => total + value, 0);
    if (sum > 0) return { watts: sum, source: "acPhases" };
  }

  // Genuinely zero (night) or genuinely unreported — indistinguishable here,
  // so the source says "none" and the caller can decide what to show.
  return { watts: 0, source: "none" };
}

export interface MapAggregateInput {
  /** EVERY inverter on the plant. Microinverter arrays report one per unit. */
  inverters: readonly InverterRealtimeDto[];
  battery?: BatteryRealtimeDto | null;
  businessType: BusinessType;
  /** The plant's UTC offset; timestamps are plant-local strings without a zone. */
  utcOffsetMinutes?: number | null;
  batteryCapacityKwh?: number | null;
}

/**
 * Plant-wide snapshot across ALL inverters.
 *
 * A microinverter array reports one device per unit — three X1-Micro units here
 * — so reading `inverters[0]` would report a third of the plant's production
 * while looking entirely plausible. Everything is summed.
 *
 * Grid is summed too but treated carefully: if NO inverter reported a grid
 * figure the result stays null, because summing nulls into 0 would claim the
 * grid is idle when it is simply unmeasured.
 */
export function mapAggregateSnapshot(input: MapAggregateInput): PowerSnapshot {
  const { inverters, battery, businessType, utcOffsetMinutes = null } = input;

  let pv = 0;
  let gridTotal = 0;
  let gridReported = false;
  let latest: Date | null = null;

  const sources = new Set<PvSource>();

  for (const inverter of inverters) {
    const resolved = resolvePvWatts(inverter, businessType);
    pv += resolved.watts;
    sources.add(resolved.source);

    const grid = normaliseGridPower(inverter.gridPower, businessType);
    if (grid !== null) {
      gridTotal += grid;
      gridReported = true;
    }

    const at = parsePlantLocalTime(inverter.plantLocalTime ?? inverter.dataTime, utcOffsetMinutes);
    if (at && (latest === null || at > latest)) latest = at;
  }

  const grid = gridReported ? gridTotal : null;
  const batteryPower = battery
    ? normaliseBatteryPower(battery.chargeDischargePower)
    : null;

  // Report the least-fidelity source in play, so a mixed fleet is described by
  // its weakest measurement rather than its best.
  const order: PvSource[] = ["none", "acPhases", "acTotal", "mpptMap", "pvMap", "mpptTotal"];
  const pvSource =
    order.find((candidate) => sources.has(candidate)) ?? "none";

  return {
    at: latest ?? new Date(),
    pv,
    battery: batteryPower,
    grid,
    load: deriveHouseLoad(pv, batteryPower, grid),
    soc: battery ? finite(battery.batterySOC) : null,
    pvSource,
  };
}

/**
 * Turns history samples from several units into one array-wide series.
 *
 * Each microinverter reports its own sample per time slot. Plotting them as
 * separate points made the curve jump between units and counted only a
 * fraction of the energy; summing them per slot gives the whole array.
 */
export function mapAggregateHistory(
  samples: readonly InverterRealtimeDto[],
  options: { businessType: BusinessType; utcOffsetMinutes: number | null; intervalMinutes: number },
): PowerSnapshot[] {
  const { businessType, utcOffsetMinutes, intervalMinutes } = options;
  const slotMs = intervalMinutes * 60_000;
  const slots = new Map<number, InverterRealtimeDto[]>();

  for (const sample of samples) {
    const at = parsePlantLocalTime(sample.plantLocalTime ?? sample.dataTime, utcOffsetMinutes);
    if (!at) continue;
    const slot = Math.round(at.getTime() / slotMs) * slotMs;
    const units = slots.get(slot);
    if (units) units.push(sample);
    else slots.set(slot, [sample]);
  }

  return [...slots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slot, inverters]) => ({
      ...mapAggregateSnapshot({ inverters, businessType, utcOffsetMinutes }),
      at: new Date(slot),
      unitsReporting: new Set(inverters.map((unit) => unit.deviceSn)).size,
    }));
}

export interface MapSnapshotInput {
  inverter: InverterRealtimeDto;
  battery?: BatteryRealtimeDto | null;
  businessType: BusinessType;
  /** The plant's UTC offset; timestamps are plant-local strings without a zone. */
  utcOffsetMinutes?: number | null;
  /** kWh, from plant info. Needed to turn SOC into stored energy. */
  batteryCapacityKwh?: number | null;
}

/**
 * Builds the domain snapshot from the raw realtime responses.
 *
 * Every optional value stays optional. In particular, when no meter or CT is
 * fitted `gridPower` is null, which makes both `grid` and the derived `load`
 * null — the UI must then say "no medible" rather than draw a zero line.
 */
export function mapPowerSnapshot(input: MapSnapshotInput): PowerSnapshot {
  const { inverter, battery, businessType, utcOffsetMinutes = null } = input;

  const { watts: pv, source: pvSource } = resolvePvWatts(inverter, businessType);

  const grid = normaliseGridPower(inverter.gridPower, businessType);
  const batteryPower = battery
    ? normaliseBatteryPower(battery.chargeDischargePower)
    : null;

  return {
    at:
      parsePlantLocalTime(inverter.plantLocalTime ?? inverter.dataTime, utcOffsetMinutes) ??
      new Date(),
    pv,
    battery: batteryPower,
    grid,
    load: deriveHouseLoad(pv, batteryPower, grid),
    soc: battery ? finite(battery.batterySOC) : null,
    pvSource,
  };
}

/**
 * Per-string readings, so an underperforming string is visible.
 *
 * `pvMap` is keyed `pv1Voltage`, `pv1Current`, `pv1Power`, with a model-
 * dependent count, so indices are discovered rather than assumed. A string
 * whose power is null is dropped (the inverter did not report it); a string
 * reporting zero is KEPT, because at night that zero is the truth and a
 * missing row would read as broken hardware instead.
 */
export function mapPvStrings(
  inverter: InverterRealtimeDto,
  businessType: BusinessType,
  /** Prefixed onto each label when several inverters feed one array. */
  devicePrefix?: string,
): PvStringReading[] {
  const map = inverter.pvMap;
  if (!map) return [];

  const indices = new Set<number>();
  for (const key of Object.keys(map)) {
    const match = /^pv(\d+)(?:Power|Voltage|Current)$/.exec(key);
    if (match?.[1]) indices.add(Number(match[1]));
  }

  const readings: PvStringReading[] = [];
  for (const index of [...indices].sort((a, b) => a - b)) {
    const watts = toWatts(map[`pv${index}Power`], businessType);
    if (watts === null) continue;
    readings.push({
      // Scoped by device: two inverters both have a "pv1" and a bare index
      // would collide as a React key and merge two panels into one row.
      id: `${inverter.deviceSn}:pv${index}`,
      label: devicePrefix ? `${devicePrefix} · ${index}` : `String ${index}`,
      watts,
      volts: finite(map[`pv${index}Voltage`]),
      amps: finite(map[`pv${index}Current`]),
    });
  }

  return readings;
}

/**
 * Every string across every inverter.
 *
 * With one inverter the labels stay "String 1..n". With several, each is
 * prefixed by its unit so an underperforming panel can be traced to hardware —
 * which is the entire point of the comparison.
 */
export function mapAllPvStrings(
  inverters: readonly InverterRealtimeDto[],
  businessType: BusinessType,
): PvStringReading[] {
  const multiple = inverters.length > 1;
  return inverters.flatMap((inverter, index) =>
    mapPvStrings(
      inverter,
      businessType,
      multiple ? `Inversor ${index + 1}` : undefined,
    ),
  );
}

/**
 * No `businessType` parameter on purpose: the battery's `chargeDischargePower`
 * is documented in watts regardless of it, and capacity comes from plant info
 * already in kWh. Taking one would imply a conversion that must not happen.
 */
export function mapBatteryState(
  battery: BatteryRealtimeDto,
  capacityKwhFromPlant?: number | null,
): BatteryState | null {
  const soc = finite(battery.batterySOC);
  if (soc === null) return null;

  const remaining = finite(battery.batteryRemainings);
  const capacityKwh =
    finite(capacityKwhFromPlant) ??
    // Fall back to inferring capacity from stored energy and SOC. Only valid
    // above a few percent, where the division is not dominated by rounding.
    (remaining !== null && soc > 5 ? (remaining / soc) * 100 : null);

  return {
    soc,
    soh: finite(battery.batterySOH),
    capacityKwh: capacityKwh ?? 0,
    storedKwh: remaining ?? (capacityKwh !== null ? (capacityKwh * soc) / 100 : null),
    cycles: finite(battery.batteryCycleTimes),
    temperatureC: finite(battery.batteryTemperature),
    power: normaliseBatteryPower(battery.chargeDischargePower) ?? 0,
  };
}

export function mapInverterState(
  inverter: InverterRealtimeDto,
  businessType: BusinessType,
  ratedPowerKw?: number | null,
): InverterState {
  const phases = [inverter.acPower1, inverter.acPower2, inverter.acPower3]
    .map((value) => toWatts(value, businessType))
    .filter((value): value is number => value !== null);

  const status = finite(inverter.deviceStatus);

  return {
    serialNumber: inverter.deviceSn,
    model: inverter.deviceModel ?? null,
    status:
      status !== null
        ? (INVERTER_STATUS[status] ?? `Estado ${status}`)
        : "Desconocido",
    temperatureC: finite(inverter.inverterTemperature),
    ratedPowerKw: finite(ratedPowerKw),
    acPowerByPhase: phases,
    pvWatts: resolvePvWatts(inverter, businessType).watts,
    gridFrequencyHz:
      finite(inverter.gridFrequency) ?? finite(inverter.acFrequency1),
  };
}
