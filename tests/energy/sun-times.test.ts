import { describe, expect, it } from "vitest";
import {
  formatMinute,
  solarPosition,
  sunTimes,
} from "@core/energy/services/sun-times";

/**
 * Verified against the SolaX portal's own readout for this plant, which is the
 * best available ground truth: on 2026-09-18 it showed sunrise 06:28 and sunset
 * 18:46 for lat 25.7646, lon -100.4783, UTC-6.
 */
const PLANT = { latitude: 25.7646, longitude: -100.4783, offsetMinutes: -360 };

function minutesOf(text: string): number {
  const [h, m] = text.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

describe("sunTimes at the real plant", () => {
  const times = sunTimes(
    PLANT.latitude,
    PLANT.longitude,
    new Date(Date.UTC(2026, 8, 18)),
    PLANT.offsetMinutes,
  );

  it("matches the vendor's sunrise within a couple of minutes", () => {
    expect(times.sunriseMinute).not.toBeNull();
    expect(Math.abs((times.sunriseMinute ?? 0) - minutesOf("06:28"))).toBeLessThanOrEqual(3);
  });

  it("matches the vendor's sunset within a couple of minutes", () => {
    expect(times.sunsetMinute).not.toBeNull();
    expect(Math.abs((times.sunsetMinute ?? 0) - minutesOf("18:46"))).toBeLessThanOrEqual(3);
  });

  it("gives roughly twelve hours of daylight near the equinox", () => {
    expect(times.daylightHours).toBeGreaterThan(11.8);
    expect(times.daylightHours).toBeLessThan(12.6);
  });

  it("places solar noon between sunrise and sunset", () => {
    expect(times.solarNoonMinute).toBeGreaterThan(times.sunriseMinute ?? 0);
    expect(times.solarNoonMinute).toBeLessThan(times.sunsetMinute ?? 1440);
  });
});

describe("seasonal behaviour", () => {
  it("gives a longer day in June than in December", () => {
    const june = sunTimes(
      PLANT.latitude,
      PLANT.longitude,
      new Date(Date.UTC(2026, 5, 21)),
      PLANT.offsetMinutes,
    );
    const december = sunTimes(
      PLANT.latitude,
      PLANT.longitude,
      new Date(Date.UTC(2026, 11, 21)),
      PLANT.offsetMinutes,
    );

    expect(june.daylightHours).toBeGreaterThan(december.daylightHours ?? 0);
    // Monterrey's swing is roughly 13.7h to 10.4h.
    expect(june.daylightHours).toBeGreaterThan(13);
    expect(december.daylightHours).toBeLessThan(11);
  });

  it("reports polar night above the Arctic circle in December", () => {
    const times = sunTimes(78, 15, new Date(Date.UTC(2026, 11, 21)), 60);
    expect(times.sunriseMinute).toBeNull();
    expect(times.daylightHours).toBe(0);
  });

  it("reports midnight sun above the Arctic circle in June", () => {
    const times = sunTimes(78, 15, new Date(Date.UTC(2026, 5, 21)), 60);
    expect(times.sunriseMinute).toBeNull();
    expect(times.daylightHours).toBe(24);
  });
});

describe("solarPosition", () => {
  const date = new Date(Date.UTC(2026, 8, 18));

  it("puts the sun below the horizon at midnight", () => {
    const position = solarPosition(
      PLANT.latitude,
      PLANT.longitude,
      date,
      PLANT.offsetMinutes,
      0,
    );
    expect(position.isDaylight).toBe(false);
    expect(position.elevation).toBeLessThan(0);
  });

  it("puts it high at midday", () => {
    const position = solarPosition(
      PLANT.latitude,
      PLANT.longitude,
      date,
      PLANT.offsetMinutes,
      13 * 60,
    );
    expect(position.isDaylight).toBe(true);
    expect(position.elevation).toBeGreaterThan(50);
  });

  it("agrees with sunrise: just before is night, just after is day", () => {
    const times = sunTimes(PLANT.latitude, PLANT.longitude, date, PLANT.offsetMinutes);
    const sunrise = times.sunriseMinute ?? 0;

    expect(
      solarPosition(PLANT.latitude, PLANT.longitude, date, PLANT.offsetMinutes, sunrise - 10)
        .isDaylight,
    ).toBe(false);
    expect(
      solarPosition(PLANT.latitude, PLANT.longitude, date, PLANT.offsetMinutes, sunrise + 10)
        .isDaylight,
    ).toBe(true);
  });

  it("distinguishes a dark night from a fault at noon", () => {
    // The whole point: 0 W at 03:00 is expected, 0 W at 13:00 is a problem.
    const night = solarPosition(PLANT.latitude, PLANT.longitude, date, PLANT.offsetMinutes, 180);
    const noon = solarPosition(PLANT.latitude, PLANT.longitude, date, PLANT.offsetMinutes, 780);
    expect(night.isDaylight).toBe(false);
    expect(noon.isDaylight).toBe(true);
  });
});

describe("formatMinute", () => {
  it("formats a plain time", () => {
    expect(formatMinute(388)).toBe("06:28");
  });

  it("renders an unknown time as a dash rather than 00:00", () => {
    expect(formatMinute(null)).toBe("—");
  });

  it("wraps values that spill past midnight", () => {
    expect(formatMinute(1500)).toBe("01:00");
    expect(formatMinute(-60)).toBe("23:00");
  });
});
