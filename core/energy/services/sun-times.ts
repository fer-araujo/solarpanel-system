/**
 * Sunrise, sunset and solar elevation from latitude and longitude.
 *
 * Pure arithmetic — no API, no key, no call budget. The plant's coordinates
 * already arrive in `page_plant_info`, so the daylight window costs nothing and
 * gives the dashboard the ambient context it was missing: when production
 * should start, when it should stop, and whether "0 W" right now means a fault
 * or simply night.
 *
 * Implements the NOAA solar position equations. Accurate to about a minute at
 * mid latitudes, which is far beyond what a dashboard needs.
 */

const DEG = Math.PI / 180;

/**
 * Sun centre at -0.833° elevation accounts for atmospheric refraction and the
 * solar disc's radius. Used when comparing an ELEVATION.
 */
const SUNRISE_ANGLE = -0.833;

/**
 * The same threshold expressed as a ZENITH angle, which is what the hour-angle
 * equation takes. These are complementary (90 - elevation) and mixing them up
 * silently pushes cos(HA) outside [-1, 1), making every day read as polar
 * night — which is exactly the bug this constant exists to prevent.
 */
const SUNRISE_ZENITH = 90.833;

export interface SunTimes {
  /** Minutes since local midnight, or null in polar day/night. */
  sunriseMinute: number | null;
  sunsetMinute: number | null;
  solarNoonMinute: number;
  /** Hours between sunrise and sunset. */
  daylightHours: number | null;
}

export interface SolarPosition {
  /** Degrees above the horizon. Negative means below it. */
  elevation: number;
  isDaylight: boolean;
}

function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((current - start) / 86_400_000);
}

/**
 * Fractional year, then the equation of time and declination.
 * Both are needed because the solar day is not exactly 24 hours.
 */
function solarTerms(date: Date): { declination: number; equationOfTime: number } {
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear(date) - 1);

  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  return { declination, equationOfTime };
}

/**
 * @param utcOffsetMinutes The plant's offset, as parsed from its timezone
 *   label. Results are in the plant's local clock.
 */
export function sunTimes(
  latitude: number,
  longitude: number,
  date: Date,
  utcOffsetMinutes: number,
): SunTimes {
  const { declination, equationOfTime } = solarTerms(date);
  const lat = latitude * DEG;

  // Solar noon, in minutes since local midnight.
  const solarNoonMinute = 720 - 4 * longitude - equationOfTime + utcOffsetMinutes;

  const cosHourAngle =
    Math.cos(SUNRISE_ZENITH * DEG) / (Math.cos(lat) * Math.cos(declination)) -
    Math.tan(lat) * Math.tan(declination);

  // Outside [-1, 1] the sun never crosses the horizon that day.
  if (cosHourAngle > 1 || cosHourAngle < -1) {
    return {
      sunriseMinute: null,
      sunsetMinute: null,
      solarNoonMinute,
      daylightHours: cosHourAngle < -1 ? 24 : 0,
    };
  }

  const hourAngle = Math.acos(cosHourAngle) / DEG;
  const sunriseMinute = solarNoonMinute - hourAngle * 4;
  const sunsetMinute = solarNoonMinute + hourAngle * 4;

  return {
    sunriseMinute,
    sunsetMinute,
    solarNoonMinute,
    daylightHours: (sunsetMinute - sunriseMinute) / 60,
  };
}

/**
 * Sun elevation at a given instant.
 *
 * Lets the UI distinguish "producing nothing because it is night" from
 * "producing nothing while the sun is up", which is the difference between a
 * calm dashboard and a fault worth investigating.
 */
export function solarPosition(
  latitude: number,
  longitude: number,
  date: Date,
  utcOffsetMinutes: number,
  minuteOfDay: number,
): SolarPosition {
  const { declination, equationOfTime } = solarTerms(date);
  const lat = latitude * DEG;

  const trueSolarTime = minuteOfDay + equationOfTime + 4 * longitude - utcOffsetMinutes;
  const hourAngle = (trueSolarTime / 4 - 180) * DEG;

  const elevation =
    Math.asin(
      Math.sin(lat) * Math.sin(declination) +
        Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle),
    ) / DEG;

  return { elevation, isDaylight: elevation > SUNRISE_ANGLE };
}

export function formatMinute(minute: number | null): string {
  if (minute === null) return "—";
  const wrapped = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = Math.round(wrapped % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
