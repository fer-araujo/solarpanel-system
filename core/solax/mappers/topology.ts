import type { SystemTopology } from "../../energy/model/power";
import type {
  BatteryInfoDto,
  EvChargerInfoDto,
  InverterInfoDto,
  InverterRealtimeDto,
  MeterInfoDto,
} from "../dto/device";
import type { PlantInfoDto } from "../dto/plant";
import {
  capacityToKwh,
  finite,
  parsePlantUtcOffsetMinutes,
  type BusinessType,
} from "./units";

export interface MapTopologyInput {
  plant: PlantInfoDto;
  inverters: readonly InverterInfoDto[];
  batteries?: readonly BatteryInfoDto[];
  meters?: readonly MeterInfoDto[];
  evChargers?: readonly EvChargerInfoDto[];
  /**
   * A realtime sample from EVERY inverter, used to detect a CT and count PV
   * strings. One entry per unit on a microinverter array, so a single sample
   * would undercount both.
   */
  samples?: readonly InverterRealtimeDto[];
  businessType: BusinessType;
}

/**
 * Discovers what the plant actually has, instead of assuming a battery and a
 * meter exist. Every capability below is genuinely optional on a residential
 * SolaX install, and the dashboard composes itself from this.
 */
export function mapTopology(input: MapTopologyInput): SystemTopology {
  const {
    plant,
    inverters,
    batteries = [],
    meters = [],
    evChargers = [],
    samples = [],
    businessType,
  } = input;

  return {
    plantId: plant.plantId,
    plantName: plant.plantName ?? "Planta",
    timeZone: plant.plantTimeZone ?? "",
    currency: plant.electricityPriceUnit ?? "MXN",
    pvCapacityKwp: positiveOrNull(plant.pvCapacity),
    batteryCapacityKwh:
      positiveOrNull(plant.batteryCapacity) ??
      inferBatteryCapacityKwh(batteries, businessType),
    latitude: finite(plant.latitude),
    longitude: finite(plant.longitude),
    utcOffsetMinutes: parsePlantUtcOffsetMinutes(plant.plantTimeZone),
    installedAt: plant.createTime ?? null,
    hasBattery: batteries.length > 0,
    hasGridMetering: detectGridMetering(meters, samples),
    hasEvCharger: evChargers.length > 0,
    pvStringCount: countPvStrings(samples),
    inverterSerialNumbers: inverters.map((inverter) => inverter.deviceSn),
  };
}

/**
 * Grid metering exists in two forms and only one of them is a device.
 *
 * A separate meter shows up in `page_device_info` with deviceType 3. A CT clamp
 * does not — it has no serial number and no device row, but the inverter does
 * report `gridPower` when one is wired in. So the honest test is "a meter is
 * listed, OR the inverter reported a grid figure at all".
 *
 * A null `gridPower` with no meter is the case that removes import/export,
 * house load, self-sufficiency, self-consumption and savings from the product.
 */
function detectGridMetering(
  meters: readonly MeterInfoDto[],
  samples: readonly InverterRealtimeDto[],
): boolean {
  if (meters.length > 0) return true;
  // Any inverter reporting a grid figure means a CT is wired somewhere.
  return samples.some(
    (sample) =>
      finite(sample.gridPower) !== null ||
      finite(sample.totalImportEnergy) !== null ||
      finite(sample.totalExportEnergy) !== null,
  );
}

/** Total panels across every unit, not just the first one's. */
function countPvStrings(samples: readonly InverterRealtimeDto[]): number {
  let total = 0;
  for (const sample of samples) {
    if (!sample.pvMap) continue;
    const indices = new Set<number>();
    for (const key of Object.keys(sample.pvMap)) {
      const match = /^pv(\d+)Power$/.exec(key);
      if (match?.[1]) indices.add(Number(match[1]));
    }
    total += indices.size;
  }
  return total;
}

function inferBatteryCapacityKwh(
  batteries: readonly BatteryInfoDto[],
  businessType: BusinessType,
): number | null {
  if (batteries.length === 0) return null;
  let total = 0;
  let seen = 0;
  for (const battery of batteries) {
    const kwh = capacityToKwh(battery.ratedCapacity, businessType);
    if (kwh === null) continue;
    total += kwh;
    seen += 1;
  }
  return seen === 0 ? null : total;
}

/**
 * Plant info returns 0.0 for capacities that were never configured in the
 * portal, which is not the same as a real zero — treat it as unknown so the UI
 * can hide a metric instead of dividing by it.
 */
function positiveOrNull(value: number | null | undefined): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}
