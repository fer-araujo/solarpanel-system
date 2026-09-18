import { z } from "zod";

/**
 * Raw SolaX shapes. These mirror the API as documented, warts included, so that
 * every accommodation lives in one reviewable place:
 *
 * - Almost everything is nullish. Fields documented as `Double` arrive as null
 *   when the hardware cannot report them (no meter, no battery, no EPS).
 * - Numeric fields are sometimes strings (`ratedPower` is documented `String`),
 *   hence `coerce`.
 * - The docs contradict themselves on casing: the inverter example returns
 *   `EPSL1Voltage` while the field table says `epsl1Voltage`. Both accepted.
 * - `totalDevicCharge` is spelled that way in the docs. Both spellings accepted
 *   rather than betting on which one production sends.
 * - `page_device_info` shows `status` in its example and `onlineStatus` in its
 *   table. Both accepted.
 *
 * Unknown keys are stripped, so SolaX adding fields never breaks a parse.
 */

const num = z.coerce.number().nullish();
const str = z.string().nullish();

/** Device types, Appendix 3. */
export const DeviceType = {
  inverter: 1,
  battery: 2,
  meter: 3,
  evCharger: 4,
  emsSystem: 100,
} as const;

/** Inverter device status, Appendix 6 (the values worth naming). */
export const INVERTER_STATUS: Record<number, string> = {
  100: "Esperando",
  101: "Autodiagnóstico",
  102: "Normal",
  103: "Falla recuperable",
  104: "Falla permanente",
  105: "Actualizando firmware",
  106: "Chequeo EPS",
  107: "EPS (aislado)",
  109: "Reposo",
  110: "Standby",
  111: "PV despertando batería",
  130: "Modo VPP",
  150: "Autoconsumo",
  152: "Respaldo",
  153: "Prioridad a inyección",
  170: "Detenido",
};

export const inverterInfoSchema = z.object({
  deviceSn: z.string(),
  registerNo: str,
  deviceModel: num,
  plantId: str,
  plantName: str,
  armVersion: str,
  dspVersion: str,
  /** kW, documented as String. */
  ratedPower: num,
  onlineStatus: num,
  status: num,
  flag: num,
});

export const batteryInfoSchema = z.object({
  deviceSn: z.string(),
  registerNo: str,
  deviceModel: num,
  plantId: str,
  softwareVersion: str,
  hardwareVersion: str,
  /** Wh when businessType=1, kWh when businessType=4. */
  ratedCapacity: num,
  onlineStatus: num,
});

export const meterInfoSchema = z.object({
  deviceSn: z.string(),
  registerNo: str,
  deviceModel: num,
  plantId: str,
  onlineStatus: num,
});

export const evChargerInfoSchema = z.object({
  deviceSn: z.string(),
  registerNo: str,
  deviceModel: num,
  plantId: str,
  armVersion: str,
  singleThreePhase: str,
  ratedPower: num,
  onlineStatus: num,
});

/**
 * `pvMap` and `mpptMap` are objects keyed `pv1Power`, `mppt3Voltage`, and so
 * on, with a variable number of strings. Parsed as a loose record and indexed
 * by the mappers rather than enumerated, because the count differs per model.
 */
const numericMapSchema = z.record(z.string(), z.coerce.number().nullish()).nullish();

export const inverterRealtimeSchema = z.object({
  deviceSn: z.string(),
  registerNo: str,
  /** UTC, ISO8601. Frequently null; prefer plantLocalTime. */
  dataTime: str,
  /** Plant-local, `YYYY-MM-DD HH:mm:ss`. */
  plantLocalTime: str,
  deviceStatus: num,
  deviceModel: str,

  acVoltage1: num,
  acVoltage2: num,
  acVoltage3: num,
  acCurrent1: num,
  acCurrent2: num,
  acCurrent3: num,
  acPower1: num,
  acPower2: num,
  acPower3: num,
  acFrequency1: num,
  acFrequency2: num,
  acFrequency3: num,
  gridFrequency: num,

  /** Positive = discharge, per the docs. */
  totalActivePower: num,
  totalReactivePower: num,
  totalPowerFactor: num,
  inverterTemperature: num,

  dailyYield: num,
  totalYield: num,
  dailyACOutput: num,
  totalACOutput: num,
  MPPTTotalInputPower: num,

  mpptMap: numericMapSchema,
  pvMap: numericMapSchema,

  /**
   * Meter 1. POSITIVE = EXPORT per the docs, which is the opposite of this
   * app's convention — the mapper flips it. Null when no meter or CT exists,
   * which is the whole reason grid metrics are optional downstream.
   */
  gridPower: num,
  todayImportEnergy: num,
  totalImportEnergy: num,
  todayExportEnergy: num,
  totalExportEnergy: num,

  gridPowerM2: num,
  todayImportEnergyM2: num,
  totalImportEnergyM2: num,
  todayExportEnergyM2: num,
  totalExportEnergyM2: num,

  // EPS: the docs use both casings. Accept both, prefer whichever is present.
  EPSL1ActivePower: num,
  EPSL2ActivePower: num,
  EPSL3ActivePower: num,
  epsl1ActivePower: num,
  epsl2ActivePower: num,
  epsl3ActivePower: num,

  l1l2Voltage: num,
  l2l3Voltage: num,
  l1l3Voltage: num,
});

export const batteryRealtimeSchema = z.object({
  deviceSn: z.string(),
  registerNo: str,
  dataTime: str,
  plantLocalTime: str,
  deviceStatus: num,

  batterySOC: num,
  batterySOH: num,
  batteryRemainings: num,
  /** W. POSITIVE = CHARGE per the docs; the mapper flips it. */
  chargeDischargePower: num,
  batteryVoltage: num,
  batteryCurrent: num,
  batteryTemperature: num,
  batteryCycleTimes: num,
  /** Documented with this typo. */
  totalDevicCharge: num,
  totalDeviceCharge: num,
  totalDeviceDischarge: num,
});

export const alarmSchema = z.object({
  alarmStartTime: str,
  alarmEndTime: str,
  alarmName: str,
  errorCode: str,
  alarmType: str,
  alarmLevel: num,
  alarmState: num,
  alarmCause: str,
  handleSuggestion: str,
  deviceSn: str,
  registerNo: str,
  deviceType: num,
  deviceModel: str,
});

export const inverterRealtimeWithAlarmsSchema = inverterRealtimeSchema.extend({
  alarmList: z.array(alarmSchema).nullish(),
});

export type InverterInfoDto = z.infer<typeof inverterInfoSchema>;
export type BatteryInfoDto = z.infer<typeof batteryInfoSchema>;
export type MeterInfoDto = z.infer<typeof meterInfoSchema>;
export type EvChargerInfoDto = z.infer<typeof evChargerInfoSchema>;
export type InverterRealtimeDto = z.infer<typeof inverterRealtimeSchema>;
export type InverterRealtimeWithAlarmsDto = z.infer<
  typeof inverterRealtimeWithAlarmsSchema
>;
export type BatteryRealtimeDto = z.infer<typeof batteryRealtimeSchema>;
export type AlarmDto = z.infer<typeof alarmSchema>;
