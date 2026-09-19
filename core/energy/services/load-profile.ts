/**
 * Estimated house load for a plant with no meter.
 *
 * Without a meter or CT the instantaneous load is unknowable, but the bill
 * history says how much the house uses per day. Spreading that over a typical
 * residential profile gives an honest ESTIMATE to set against production —
 * clearly labelled as such, never presented as a measurement.
 *
 * The profile is a warm-climate household with air conditioning: a quiet
 * night, a moderate day and a peak in the late afternoon and evening, when
 * people are home and the heat has built up.
 */

const HOURLY_WEIGHTS = [
  0.9, 0.8, 0.75, 0.7, 0.7, 0.75, 0.9, 1.0, 0.95, 0.9, 0.9, 0.95,
  1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.6, 1.5, 1.35, 1.15, 1.0,
] as const;

const WEIGHT_SUM = HOURLY_WEIGHTS.reduce((sum, w) => sum + w, 0);

/**
 * Average watts for each hour of the day (index 0 = 00:00–01:00) that add up
 * to `dailyKwh` over the day.
 */
export function estimateHourlyLoadWatts(dailyKwh: number): number[] {
  if (!(dailyKwh > 0)) return [];
  return HOURLY_WEIGHTS.map((weight) => (dailyKwh * 1000 * weight) / WEIGHT_SUM);
}

/** Estimated watts at a minute of the day, interpolated between hour midpoints. */
export function estimatedLoadAt(hourly: readonly number[], minute: number): number | null {
  if (hourly.length !== 24) return null;
  const position = minute / 60 - 0.5;
  const lower = Math.floor(position);
  const t = position - lower;
  const a = hourly[(lower + 24) % 24] ?? 0;
  const b = hourly[(lower + 1) % 24] ?? 0;
  return a + (b - a) * t;
}
