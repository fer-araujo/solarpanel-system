/**
 * Unit and sign normalisation — the single place SolaX's inconsistencies are
 * absorbed. Everything past this file speaks one language.
 *
 * TWO traps live here, and both are silent if unhandled:
 *
 * 1. UNITS DEPEND ON businessType. Power fields are watts for Residential (1)
 *    and kilowatts for Commercial & Industrial (4). Reading a C&I response as
 *    watts is a 1000x error that still looks like a plausible number.
 *
 * 2. SIGNS CONTRADICT BETWEEN ENDPOINTS:
 *      - `gridPower`: positive = EXPORT
 *      - `chargeDischargePower`: positive = CHARGE
 *      - `totalActivePower`: positive = DISCHARGE
 *    This app uses ONE convention — positive = into the house — so grid and
 *    battery are both flipped on the way in.
 */

export type BusinessType = 1 | 4;

/** Converts a documented power field to watts. */
export function toWatts(
  value: number | null | undefined,
  businessType: BusinessType,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return businessType === 1 ? value : value * 1000;
}

/**
 * Battery `chargeDischargePower` is documented in WATTS regardless of
 * businessType, unlike the inverter's power fields. Kept separate so the
 * exception is explicit instead of a comment someone deletes.
 */
export function batteryPowerToWatts(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value;
}

/** Converts a documented capacity field to kWh. */
export function capacityToKwh(
  value: number | null | undefined,
  businessType: BusinessType,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  // Wh for Residential, kWh for C&I.
  return businessType === 1 ? value / 1000 : value;
}

/**
 * Grid flow in this app's convention: positive = importing from the grid.
 * SolaX reports the opposite, so this negates.
 */
export function normaliseGridPower(
  gridPower: number | null | undefined,
  businessType: BusinessType,
): number | null {
  const watts = toWatts(gridPower, businessType);
  return watts === null ? null : -watts;
}

/**
 * Battery flow in this app's convention: positive = discharging into the house.
 * SolaX reports positive as charging, so this negates.
 */
export function normaliseBatteryPower(
  chargeDischargePower: number | null | undefined,
): number | null {
  const watts = batteryPowerToWatts(chargeDischargePower);
  return watts === null ? null : -watts;
}

/** Plain number or null; `0` is preserved, unlike a `|| null` fallback. */
export function finite(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Sums the `pvNPower` entries of a `pvMap`.
 *
 * Used only when `MPPTTotalInputPower` is null, which the docs show happening.
 * Returns null rather than 0 for an empty map, so "no strings reported" stays
 * distinguishable from "strings reporting zero at night".
 */
export function sumPvMapPower(
  pvMap: Record<string, number | null | undefined> | null | undefined,
  businessType: BusinessType,
): number | null {
  if (!pvMap) return null;
  let total = 0;
  let seen = 0;
  for (const [key, value] of Object.entries(pvMap)) {
    if (!/^pv\d+Power$/.test(key)) continue;
    const watts = toWatts(value, businessType);
    if (watts === null) continue;
    total += watts;
    seen += 1;
  }
  return seen === 0 ? null : total;
}

/**
 * Sums the `mpptNPower` entries of an `mpptMap`.
 *
 * Same shape as `sumPvMapPower` but for the MPPT tracker view, which some
 * models populate instead of the per-string one.
 */
export function sumMpptMapPower(
  mpptMap: Record<string, number | null | undefined> | null | undefined,
  businessType: BusinessType,
): number | null {
  if (!mpptMap) return null;
  let total = 0;
  let seen = 0;
  for (const [key, value] of Object.entries(mpptMap)) {
    if (!/^mppt\d+Power$/.test(key)) continue;
    const watts = toWatts(value, businessType);
    if (watts === null) continue;
    total += watts;
    seen += 1;
  }
  return seen === 0 ? null : total;
}

/**
 * Extracts the UTC offset, in minutes, from the plant's timezone string.
 *
 * SolaX returns it as `"(UTC-06:00)Guadalajara, Mexico City"` — a label, not an
 * IANA id, despite the docs calling it IANA. Only the offset is reliable, and
 * it does NOT track daylight saving, so a plant that observes DST will drift by
 * an hour for part of the year. Returns null rather than guessing when the
 * string does not match, so a caller can fall back to the server's own day
 * boundaries instead of silently shifting every timestamp.
 */
export function parsePlantUtcOffsetMinutes(
  timeZone: string | null | undefined,
): number | null {
  if (!timeZone) return null;
  const match = /UTC([+-])(\d{2}):(\d{2})/i.exec(timeZone);
  if (!match) return null;
  const [, sign, hours, minutes] = match;
  const total = Number(hours) * 60 + Number(minutes);
  return sign === "-" ? -total : total;
}

/**
 * Start and end of the plant's local day, as UTC milliseconds.
 *
 * Needed because "today" on the dashboard means the plant's day, not the
 * server's. With no usable offset it falls back to the host's local day and
 * says so via `exact`, so the UI can avoid claiming precision it lacks.
 */
export function plantLocalDayBounds(
  timeZone: string | null | undefined,
  at: Date = new Date(),
): { startMs: number; endMs: number; exact: boolean } {
  const offsetMinutes = parsePlantUtcOffsetMinutes(timeZone);

  if (offsetMinutes === null) {
    const start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    return {
      startMs: start.getTime(),
      endMs: start.getTime() + 86_400_000,
      exact: false,
    };
  }

  const offsetMs = offsetMinutes * 60_000;
  // Shift into plant-local terms, truncate to the day, shift back.
  const localNow = at.getTime() + offsetMs;
  const localMidnight = Math.floor(localNow / 86_400_000) * 86_400_000;
  return {
    startMs: localMidnight - offsetMs,
    endMs: localMidnight - offsetMs + 86_400_000,
    exact: true,
  };
}

/** Plant-local bounds of a specific `YYYY-MM-DD` day, as UTC milliseconds. */
export function plantDayBoundsFor(
  date: string,
  timeZone: string | null | undefined,
): { startMs: number; endMs: number; exact: boolean } {
  const [y, m, d] = date.split("-").map(Number);
  const offsetMinutes = parsePlantUtcOffsetMinutes(timeZone);
  if (offsetMinutes === null) {
    const start = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
    return { startMs: start, endMs: start + 86_400_000, exact: false };
  }
  const start = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) - offsetMinutes * 60_000;
  return { startMs: start, endMs: start + 86_400_000, exact: true };
}

/**
 * Parses `YYYY-MM-DD HH:mm:ss` as reported in plant-local time.
 *
 * The string carries no zone, so the plant's offset turns it into a real
 * instant. Reading it in the HOST's zone instead only works while the server
 * happens to share the plant's zone: on a UTC server (Vercel) every timestamp
 * lands six hours off. The host zone is used only when the offset is unknown.
 */
export function parsePlantLocalTime(
  value: string | null | undefined,
  utcOffsetMinutes: number | null = null,
): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  if (utcOffsetMinutes !== null) {
    const utc = Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      s ? Number(s) : 0,
    );
    return Number.isNaN(utc) ? null : new Date(utc - utcOffsetMinutes * 60_000);
  }
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}
