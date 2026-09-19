import { describe, expect, it } from "vitest";
import { estimatedLoadAt, estimateHourlyLoadWatts } from "@core/energy/services/load-profile";

describe("estimated load profile", () => {
  it("adds up to the daily consumption", () => {
    const hourly = estimateHourlyLoadWatts(22);
    const kwh = hourly.reduce((sum, watts) => sum + watts, 0) / 1000;
    expect(kwh).toBeCloseTo(22, 6);
  });

  it("peaks in the evening, not at night", () => {
    const hourly = estimateHourlyLoadWatts(22);
    expect(hourly[19]!).toBeGreaterThan(hourly[3]!);
  });

  it("returns nothing without a consumption history", () => {
    expect(estimateHourlyLoadWatts(0)).toEqual([]);
    expect(estimatedLoadAt([], 600)).toBeNull();
  });

  it("interpolates between hour midpoints", () => {
    const hourly = estimateHourlyLoadWatts(24);
    expect(estimatedLoadAt(hourly, 12 * 60 + 30)).toBeCloseTo(hourly[12]!, 6);
  });
});
