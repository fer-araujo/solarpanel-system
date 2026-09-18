/**
 * Domain model for an instant of the system.
 *
 * Sign convention, normalised here once so nothing downstream has to think
 * about SolaX's contradictory per-endpoint signs:
 *   positive = energy flowing INTO the house.
 *   pv      >= 0 always
 *   battery  > 0 discharging to the house, < 0 charging
 *   grid     > 0 importing, < 0 exporting
 *
 * Balance: pv + battery + grid === load
 *
 * `null` never means zero. It means the hardware cannot report the value:
 * no battery fitted, or no meter/CT so grid flow is unmeasurable. The UI must
 * render absence differently from a real zero, which is why these are nullable
 * all the way through instead of being defaulted at the edge.
 */

/** Instantaneous power, watts. */
export type Watts = number;

/** Energy, kilowatt-hours. */
export type KilowattHours = number;

/** 0-100. */
export type Percentage = number;

export interface PowerSnapshot {
  /** Instant the inverter reported, in plant-local terms. */
  at: Date;
  pv: Watts;
  /** null when no battery is fitted. */
  battery: Watts | null;
  /** null when no meter or CT is installed — grid flow is unmeasurable. */
  grid: Watts | null;
  /** Derived, never read. null whenever `grid` is null. */
  load: Watts | null;
  soc: Percentage | null;
  /**
   * Which field `pv` was read from. Models differ in what they populate, and
   * the AC-side fallbacks measure inverter output rather than panel production,
   * so the figure's provenance travels with it. "none" means nothing reported
   * — which at night is indistinguishable from a true zero.
   */
  pvSource?: string;
}

export interface PowerSample {
  at: Date;
  pv: Watts;
  battery: Watts | null;
  grid: Watts | null;
  load: Watts | null;
  soc: Percentage | null;
}

export interface BatteryState {
  soc: Percentage;
  /** State of health, percent of original capacity. */
  soh: Percentage | null;
  capacityKwh: KilowattHours;
  storedKwh: KilowattHours | null;
  cycles: number | null;
  temperatureC: number | null;
  /** Mirrors `PowerSnapshot.battery`: > 0 discharging, < 0 charging. */
  power: Watts;
}

export interface PvStringReading {
  id: string;
  label: string;
  watts: Watts;
  volts: number | null;
  amps: number | null;
}

export interface InverterState {
  serialNumber: string;
  model: string | null;
  status: string;
  temperatureC: number | null;
  ratedPowerKw: number | null;
  acPowerByPhase: Watts[];
  /** This unit's own production, so a microinverter array shows per-unit output. */
  pvWatts: Watts;
  gridFrequencyHz: number | null;
}

/**
 * What the plant actually has fitted. Derived from `page_device_info` rather
 * than assumed, because every capability below is genuinely optional on a
 * residential SolaX install.
 */
export interface SystemTopology {
  plantId: string;
  plantName: string;
  timeZone: string;
  currency: string;
  pvCapacityKwp: number | null;
  batteryCapacityKwh: number | null;
  /**
   * Plant coordinates and UTC offset. Enough to compute sunrise, sunset and sun
   * elevation locally, which is what separates "producing nothing because it is
   * night" from "producing nothing while the sun is up".
   */
  latitude: number | null;
  longitude: number | null;
  utcOffsetMinutes: number | null;
  /** ISO date the plant was registered — the earliest year worth querying. */
  installedAt: string | null;
  hasBattery: boolean;
  /** A meter or CT. Without it there is no grid import/export at all. */
  hasGridMetering: boolean;
  hasEvCharger: boolean;
  pvStringCount: number;
  inverterSerialNumbers: string[];
}

/** Everything that depends on knowing grid flow. */
export function gridDependentMetricsAvailable(topology: SystemTopology): boolean {
  return topology.hasGridMetering;
}
