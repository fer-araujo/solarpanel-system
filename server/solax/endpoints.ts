import { z } from "zod";
import { pagedSchema } from "@core/solax/dto/envelope";
import {
  batteryInfoSchema,
  batteryRealtimeSchema,
  alarmSchema,
  evChargerInfoSchema,
  inverterInfoSchema,
  inverterRealtimeSchema,
  inverterRealtimeWithAlarmsSchema,
  meterInfoSchema,
  DeviceType,
} from "@core/solax/dto/device";
import {
  plantInfoSchema,
  plantRealtimeSchema,
  plantStatDataSchema,
} from "@core/solax/dto/plant";
import type { BusinessType } from "@core/solax/mappers/units";
import type { SolaxHttpClient } from "./http-client";

/**
 * One function per SolaX endpoint. Each validates its own response, so a
 * contract change surfaces as a named parse error instead of an undefined deep
 * in a chart.
 */

/** `history_data` refuses a window longer than this. */
export const HISTORY_MAX_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Documented `timeInterval` values, in minutes. */
export type HistoryInterval = 5 | 10 | 15 | 30 | 60;

export class SolaxEndpoints {
  constructor(
    private readonly http: SolaxHttpClient,
    private readonly businessType: BusinessType,
  ) {}

  async listPlants(pageNo = 1) {
    const result = await this.http.get("/openapi/v2/plant/page_plant_info", {
      businessType: this.businessType,
      pageNo,
    });
    return pagedSchema(plantInfoSchema).parse(result).records ?? [];
  }

  async getPlantRealtime(plantId: string) {
    const result = await this.http.get("/openapi/v2/plant/realtime_data", {
      plantId,
      businessType: this.businessType,
    });
    return plantRealtimeSchema.parse(result);
  }

  async listInverters(plantId?: string) {
    return this.listDevices(DeviceType.inverter, inverterInfoSchema, plantId);
  }

  async listBatteries(plantId?: string) {
    return this.listDevices(DeviceType.battery, batteryInfoSchema, plantId);
  }

  async listMeters(plantId?: string) {
    return this.listDevices(DeviceType.meter, meterInfoSchema, plantId);
  }

  async listEvChargers(plantId?: string) {
    return this.listDevices(DeviceType.evCharger, evChargerInfoSchema, plantId);
  }

  private async listDevices<T extends z.ZodTypeAny>(
    deviceType: number,
    schema: T,
    plantId?: string,
  ): Promise<z.infer<T>[]> {
    const result = await this.http.get("/openapi/v2/device/page_device_info", {
      deviceType,
      businessType: this.businessType,
      ...(plantId ? { plantId } : {}),
    });
    return pagedSchema(schema).parse(result).records ?? [];
  }

  /** Max 10 serial numbers per call, per the docs. */
  async getInverterRealtime(serialNumbers: readonly string[]) {
    assertSnLimit(serialNumbers);
    const result = await this.http.get("/openapi/v2/device/realtime_data", {
      snList: serialNumbers.join(","),
      deviceType: DeviceType.inverter,
      businessType: this.businessType,
    });
    return z.array(inverterRealtimeSchema).parse(result ?? []);
  }

  /**
   * Realtime plus the five most recent active alarms.
   *
   * KNOWN BROKEN on this account: returns HTTP 500. Not used by `/api/snapshot`,
   * which reads `realtime_data` and takes alarms from `alarm/page_alarm_info`
   * instead. Kept so `/api/diag` can report whether it ever starts working.
   *
   * The documentation is self-contradictory — declared GET with "Params
   * parameters" but illustrated with a JSON body — which may be the cause. This
   * follows the declared method, matching its sibling `realtime_data`.
   */
  async getInverterRealtimeWithAlarms(serialNumbers: readonly string[]) {
    assertSnLimit(serialNumbers);
    const result = await this.http.get("/openapi/v2/device/data/realtime", {
      snList: serialNumbers.join(","),
      deviceType: DeviceType.inverter,
      businessType: this.businessType,
    });
    return z.array(inverterRealtimeWithAlarmsSchema).parse(result ?? []);
  }

  /**
   * Battery realtime. With `requestSnType=1` the serials are INVERTER serials
   * and every battery under them is returned, which is the only way to read a
   * battery that has no serial of its own.
   */
  async getBatteryRealtime(
    serialNumbers: readonly string[],
    by: "inverter" | "battery" = "inverter",
  ) {
    assertSnLimit(serialNumbers);
    const result = await this.http.get("/openapi/v2/device/realtime_data", {
      snList: serialNumbers.join(","),
      deviceType: DeviceType.battery,
      requestSnType: by === "inverter" ? 1 : 2,
      businessType: this.businessType,
    });
    return z.array(batteryRealtimeSchema).parse(result ?? []);
  }

  /**
   * A single history window. `endTime - startTime` must not exceed 12 hours —
   * the limit is enforced here rather than discovered as an API error.
   */
  async getInverterHistoryWindow(options: {
    serialNumbers: readonly string[];
    startMs: number;
    endMs: number;
    interval: HistoryInterval;
  }) {
    const { serialNumbers, startMs, endMs, interval } = options;
    assertSnLimit(serialNumbers);

    if (endMs <= startMs) {
      throw new Error("history window end must be after its start");
    }
    if (endMs - startMs > HISTORY_MAX_WINDOW_MS) {
      throw new Error(
        `history window is ${Math.round((endMs - startMs) / 3600000)}h; SolaX allows 12h per request`,
      );
    }

    const result = await this.http.get("/openapi/v2/device/history_data", {
      snList: serialNumbers.join(","),
      deviceType: DeviceType.inverter,
      businessType: this.businessType,
      startTime: startMs,
      endTime: endMs,
      timeInterval: interval,
    });
    return z.array(inverterRealtimeSchema).parse(result ?? []);
  }

  /**
   * A whole span, split into 12-hour windows and fetched sequentially.
   *
   * Sequential on purpose: parallel requests would spend the per-minute budget
   * in one burst and trip 10406, which costs more time than it saves.
   */
  async getInverterHistory(options: {
    serialNumbers: readonly string[];
    startMs: number;
    endMs: number;
    interval: HistoryInterval;
  }) {
    const { serialNumbers, startMs, endMs, interval } = options;
    const windows: { startMs: number; endMs: number }[] = [];
    for (let cursor = startMs; cursor < endMs; cursor += HISTORY_MAX_WINDOW_MS) {
      windows.push({
        startMs: cursor,
        endMs: Math.min(cursor + HISTORY_MAX_WINDOW_MS, endMs),
      });
    }

    const samples: z.infer<typeof inverterRealtimeSchema>[] = [];
    for (const window of windows) {
      samples.push(
        ...(await this.getInverterHistoryWindow({
          serialNumbers,
          interval,
          ...window,
        })),
      );
    }
    return samples;
  }

  /**
   * Aggregated energy. `dateType` 1 with `date` "2026" gives each month of the
   * year; `dateType` 2 with "2026-09" gives each day of the month. One request
   * covers a whole year, which is why no local history store is needed.
   */
  async getPlantStats(options: {
    plantId: string;
    dateType: 1 | 2;
    date: string;
  }) {
    const result = await this.http.post("/openapi/v2/plant/energy/get_stat_data", {
      plantId: options.plantId,
      dateType: String(options.dateType),
      date: options.date,
      businessType: String(this.businessType),
    });
    return plantStatDataSchema.parse(result);
  }

  async listAlarms(options: {
    plantId: string;
    /** 0 closed, 1 ongoing. */
    alarmState: 0 | 1;
    pageNo?: number;
  }) {
    const result = await this.http.get("/openapi/v2/alarm/page_alarm_info", {
      plantId: options.plantId,
      alarmState: options.alarmState,
      businessType: this.businessType,
      pageNo: options.pageNo ?? 1,
    });
    return pagedSchema(alarmSchema).parse(result).records ?? [];
  }
}

function assertSnLimit(serialNumbers: readonly string[]): void {
  if (serialNumbers.length === 0) {
    throw new Error("at least one device serial number is required");
  }
  if (serialNumbers.length > 10) {
    throw new Error(
      `${serialNumbers.length} serial numbers requested; SolaX allows 10 per call`,
    );
  }
}
