import { describe, expect, it } from "vitest";
import { parsePlantLocalTime, parsePlantUtcOffsetMinutes } from "@core/solax/mappers/units";

describe("plant-local timestamps", () => {
  const offset = parsePlantUtcOffsetMinutes("(UTC-06:00)Chihuahua, La Paz, Mazatlan");

  it("reads the plant's offset from its timezone label", () => {
    expect(offset).toBe(-360);
  });

  it("turns plant-local time into the right instant whatever the host zone is", () => {
    // 09:20 in Monterrey (UTC-6) is 15:20 UTC — on a UTC server too.
    expect(parsePlantLocalTime("2026-09-18 09:20:00", offset)?.toISOString()).toBe(
      "2026-09-18T15:20:00.000Z",
    );
  });

  it("rolls into the next UTC day for late plant-local times", () => {
    expect(parsePlantLocalTime("2026-09-18 21:05", offset)?.toISOString()).toBe(
      "2026-09-19T03:05:00.000Z",
    );
  });

  it("rejects malformed input", () => {
    expect(parsePlantLocalTime("ayer", offset)).toBeNull();
  });
});
