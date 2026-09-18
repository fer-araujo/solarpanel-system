import { z } from "zod";

const num = z.coerce.number().nullish();
const str = z.string().nullish();

/** Plant state, Appendix 2 (residential: 0 connecting, 1 offline, >1 online). */
export const plantInfoSchema = z.object({
  plantId: z.union([z.string(), z.number()]).transform(String),
  plantName: str,
  loginName: str,
  /** kWh. */
  batteryCapacity: num,
  /** kWp. */
  pvCapacity: num,
  createTime: str,
  /** IANA-ish string, e.g. "(UTC+01:00)Amsterdam, Berlin, ...". */
  plantTimeZone: str,
  plantState: num,
  plantAddress: str,
  longitude: num,
  latitude: num,
  /** ISO 4217, e.g. "MXN". */
  electricityPriceUnit: str,
});

export const plantRealtimeSchema = z.object({
  plantId: z.union([z.string(), z.number()]).transform(String).nullish(),
  /** Plant-local, `YYYY-MM-DD HH:mm:ss`. */
  plantLocalTime: str,
  dailyYield: num,
  totalYield: num,
  dailyCharged: num,
  totalCharged: num,
  dailyDischarged: num,
  totalDischarged: num,
  dailyImported: num,
  totalImported: num,
  dailyExported: num,
  totalExported: num,
  dailyEarnings: num,
  totalEarnings: num,
});

/**
 * One bucket of `plant/energy/get_stat_data`. With `dateType=1` each entry is a
 * month of the year (`2026-09`); with `dateType=2` each entry is a day of the
 * month (`2026-09-03`).
 */
export const plantEnergyStatSchema = z.object({
  date: z.string(),
  /** kWh. */
  pvGeneration: num,
  inverterACOutputEnergy: num,
  exportEnergy: num,
  importEnergy: num,
  loadConsumption: num,
  batteryCharged: num,
  batteryDischarged: num,
  earnings: num,
});

export const plantStatDataSchema = z.object({
  plantId: z.union([z.string(), z.number()]).transform(String).nullish(),
  date: str,
  currencyCode: str,
  plantEnergyStatDataList: z.array(plantEnergyStatSchema).nullish(),
});

export type PlantInfoDto = z.infer<typeof plantInfoSchema>;
export type PlantRealtimeDto = z.infer<typeof plantRealtimeSchema>;
export type PlantEnergyStatDto = z.infer<typeof plantEnergyStatSchema>;
export type PlantStatDataDto = z.infer<typeof plantStatDataSchema>;
