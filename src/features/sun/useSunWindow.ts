import { useMemo } from "react";
import type { SystemTopology } from "@core/energy/model/power";
import {
  formatMinute,
  solarPosition,
  sunTimes,
} from "@core/energy/services/sun-times";

export interface SunWindow {
  sunriseMinute: number | null;
  sunsetMinute: number | null;
  sunrise: string;
  sunset: string;
  daylightHours: number | null;
  /** Sun elevation right now, degrees. */
  elevation: number;
  isDaylight: boolean;
}

/**
 * Daylight window and current sun elevation for the plant.
 *
 * Computed locally from the coordinates already in the topology, so it costs no
 * API call. Its job on the dashboard is to give zero production a meaning: at
 * 03:00 it is expected, at 13:00 it is a fault.
 */
export function useSunWindow(
  topology: SystemTopology | undefined,
  now: Date = new Date(),
): SunWindow | null {
  return useMemo(() => {
    if (
      !topology ||
      topology.latitude === null ||
      topology.longitude === null ||
      topology.utcOffsetMinutes === null
    ) {
      return null;
    }

    const { latitude, longitude, utcOffsetMinutes } = topology;
    const times = sunTimes(latitude, longitude, now, utcOffsetMinutes);
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    const position = solarPosition(
      latitude,
      longitude,
      now,
      utcOffsetMinutes,
      minuteOfDay,
    );

    return {
      sunriseMinute: times.sunriseMinute,
      sunsetMinute: times.sunsetMinute,
      sunrise: formatMinute(times.sunriseMinute),
      sunset: formatMinute(times.sunsetMinute),
      daylightHours: times.daylightHours,
      elevation: position.elevation,
      isDaylight: position.isDaylight,
    };
    // Recomputed per minute is unnecessary; the hour is enough resolution.
  }, [topology, now.getHours()]);
}
