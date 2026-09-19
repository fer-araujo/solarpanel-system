import { describe, expect, it } from "vitest";
import {
  batteryRealtimeSchema,
  inverterRealtimeSchema,
  type BatteryRealtimeDto,
  type InverterRealtimeDto,
} from "@core/solax/dto/device";
import { plantInfoSchema } from "@core/solax/dto/plant";
import {
  mapAggregateHistory,
  mapAggregateSnapshot,
  mapAllPvStrings,
  mapBatteryState,
  mapInverterState,
  mapPowerSnapshot,
  mapPvStrings,
} from "@core/solax/mappers/snapshot";
import { mapTopology } from "@core/solax/mappers/topology";
import {
  normaliseBatteryPower,
  normaliseGridPower,
  toWatts,
} from "@core/solax/mappers/units";
import { SolaxError, unwrapEnvelope } from "@core/solax/dto/envelope";

/**
 * These tests exist because the sign and unit conventions are the single
 * highest-risk part of the integration: every mistake here still produces a
 * plausible-looking number, so nothing catches it at runtime.
 */

function inverter(overrides: Partial<InverterRealtimeDto> = {}): InverterRealtimeDto {
  return inverterRealtimeSchema.parse({
    deviceSn: "X3TEST0001",
    plantLocalTime: "2026-09-17 14:10:00",
    deviceStatus: 102,
    MPPTTotalInputPower: 6800,
    gridPower: 0,
    inverterTemperature: 47.3,
    acPower1: 2200,
    acPower2: 2100,
    acPower3: 2300,
    gridFrequency: 60,
    ...overrides,
  });
}

function battery(overrides: Partial<BatteryRealtimeDto> = {}): BatteryRealtimeDto {
  return batteryRealtimeSchema.parse({
    deviceSn: "BATTEST0001",
    batterySOC: 64,
    batterySOH: 98.4,
    chargeDischargePower: 0,
    batteryCycleTimes: 214,
    batteryTemperature: 28.6,
    ...overrides,
  });
}

describe("unit conversion by businessType", () => {
  it("treats Residential power as watts", () => {
    expect(toWatts(6800, 1)).toBe(6800);
  });

  it("treats C&I power as kilowatts", () => {
    expect(toWatts(6.8, 4)).toBe(6800);
  });

  it("keeps null distinct from zero", () => {
    expect(toWatts(null, 1)).toBeNull();
    expect(toWatts(0, 1)).toBe(0);
  });
});

describe("sign normalisation", () => {
  it("flips gridPower, which SolaX reports positive for EXPORT", () => {
    // Exporting 2 kW -> negative in this app's convention.
    expect(normaliseGridPower(2000, 1)).toBe(-2000);
    // Importing 1.5 kW.
    expect(normaliseGridPower(-1500, 1)).toBe(1500);
  });

  it("flips chargeDischargePower, which SolaX reports positive for CHARGE", () => {
    // Charging at 3 kW -> negative (leaving the house).
    expect(normaliseBatteryPower(3000)).toBe(-3000);
    // Discharging at 1 kW -> positive (into the house).
    expect(normaliseBatteryPower(-1000)).toBe(1000);
  });
});

describe("mapPowerSnapshot", () => {
  it("satisfies pv + battery + grid = load", () => {
    // Producing 6.8 kW, charging the battery at 3 kW, exporting 1.5 kW.
    const snapshot = mapPowerSnapshot({
      inverter: inverter({ MPPTTotalInputPower: 6800, gridPower: 1500 }),
      battery: battery({ chargeDischargePower: 3000 }),
      businessType: 1,
    });

    expect(snapshot.pv).toBe(6800);
    expect(snapshot.battery).toBe(-3000);
    expect(snapshot.grid).toBe(-1500);
    expect(snapshot.load).toBe(6800 - 3000 - 1500);
  });

  it("falls back to summing pvMap when MPPTTotalInputPower is null", () => {
    const snapshot = mapPowerSnapshot({
      inverter: inverter({
        MPPTTotalInputPower: null,
        pvMap: { pv1Power: 1800, pv2Power: 1850, pv3Power: 1400, pv1Voltage: 372 },
      }),
      businessType: 1,
    });
    expect(snapshot.pv).toBe(5050);
  });

  it("leaves grid and load null when no meter or CT reports", () => {
    const snapshot = mapPowerSnapshot({
      inverter: inverter({ gridPower: null }),
      battery: battery({ chargeDischargePower: -1000 }),
      businessType: 1,
    });

    expect(snapshot.grid).toBeNull();
    // Unknowable without grid flow — must not collapse to zero.
    expect(snapshot.load).toBeNull();
    expect(snapshot.battery).toBe(1000);
  });

  it("leaves battery null when no battery is fitted", () => {
    const snapshot = mapPowerSnapshot({
      inverter: inverter(),
      businessType: 1,
    });
    expect(snapshot.battery).toBeNull();
    expect(snapshot.soc).toBeNull();
    // Grid is known, so load still resolves.
    expect(snapshot.load).toBe(6800);
  });

  it("reads plant-local time without shifting it into another zone", () => {
    const snapshot = mapPowerSnapshot({
      inverter: inverter({ plantLocalTime: "2026-09-17 14:10:00" }),
      businessType: 1,
    });
    expect(snapshot.at.getHours()).toBe(14);
    expect(snapshot.at.getMinutes()).toBe(10);
  });
});

describe("mapAggregateSnapshot across a microinverter array", () => {
  /**
   * Modelled on the real plant: three X1-Micro units, 2.4 kW each, no battery
   * and no meter. Reading only `inverters[0]` reported a third of production
   * while looking entirely plausible — which is exactly why this is pinned.
   */
  const micros = [
    inverter({ deviceSn: "MICRO-1", MPPTTotalInputPower: 1800 }),
    inverter({ deviceSn: "MICRO-2", MPPTTotalInputPower: 1650 }),
    inverter({ deviceSn: "MICRO-3", MPPTTotalInputPower: 1720 }),
  ];

  it("sums production across every unit", () => {
    const snapshot = mapAggregateSnapshot({ inverters: micros, businessType: 1 });
    expect(snapshot.pv).toBe(1800 + 1650 + 1720);
  });

  it("does not report a third of the plant from the first unit", () => {
    const aggregate = mapAggregateSnapshot({ inverters: micros, businessType: 1 });
    const firstOnly = mapPowerSnapshot({
      inverter: micros[0] as InverterRealtimeDto,
      businessType: 1,
    });
    expect(aggregate.pv).toBeGreaterThan(firstOnly.pv * 2);
  });

  it("leaves grid null when no unit reports one", () => {
    const snapshot = mapAggregateSnapshot({
      inverters: micros.map((unit) => ({ ...unit, gridPower: null })),
      businessType: 1,
    });
    expect(snapshot.grid).toBeNull();
    expect(snapshot.load).toBeNull();
  });

  it("sums grid when a CT is wired to one unit only", () => {
    const snapshot = mapAggregateSnapshot({
      inverters: [
        { ...(micros[0] as InverterRealtimeDto), gridPower: 900 },
        { ...(micros[1] as InverterRealtimeDto), gridPower: null },
        { ...(micros[2] as InverterRealtimeDto), gridPower: null },
      ],
      businessType: 1,
    });
    // 900 exported in SolaX terms becomes -900 in ours.
    expect(snapshot.grid).toBe(-900);
  });

  it("takes the most recent timestamp of the array", () => {
    const snapshot = mapAggregateSnapshot({
      inverters: [
        { ...(micros[0] as InverterRealtimeDto), plantLocalTime: "2026-09-17 14:05:00" },
        { ...(micros[1] as InverterRealtimeDto), plantLocalTime: "2026-09-17 14:10:00" },
      ],
      businessType: 1,
    });
    expect(snapshot.at.getMinutes()).toBe(10);
  });
});

describe("mapAllPvStrings", () => {
  it("keeps panels from different units distinct", () => {
    const strings = mapAllPvStrings(
      [
        inverter({ deviceSn: "MICRO-1", pvMap: { pv1Power: 400, pv2Power: 410 } }),
        inverter({ deviceSn: "MICRO-2", pvMap: { pv1Power: 395, pv2Power: 380 } }),
      ],
      1,
    );

    expect(strings).toHaveLength(4);
    // Ids must be unique or two panels collapse into one row.
    expect(new Set(strings.map((s) => s.id)).size).toBe(4);
    expect(strings[0]?.label).toBe("Inversor 1 · 1");
    expect(strings[2]?.label).toBe("Inversor 2 · 1");
  });

  it("does not prefix labels when there is only one inverter", () => {
    const strings = mapAllPvStrings(
      [inverter({ pvMap: { pv1Power: 400 } })],
      1,
    );
    expect(strings[0]?.label).toBe("String 1");
  });
});

describe("mapPvStrings", () => {
  it("discovers strings and keeps a genuine zero", () => {
    const strings = mapPvStrings(
      inverter({
        pvMap: {
          pv1Power: 1800,
          pv1Voltage: 372,
          pv1Current: 4.8,
          pv2Power: 0,
          pv2Voltage: 0,
          pv2Current: 0,
        },
      }),
      1,
    );

    expect(strings).toHaveLength(2);
    expect(strings[0]?.watts).toBe(1800);
    expect(strings[1]?.watts).toBe(0);
  });

  it("drops a string the inverter did not report at all", () => {
    const strings = mapPvStrings(
      inverter({ pvMap: { pv1Power: 1800, pv2Voltage: 370, pv2Power: null } }),
      1,
    );
    // Ids are scoped by device serial so two units' "pv1" cannot collide.
    expect(strings.map((s) => s.id)).toEqual(["X3TEST0001:pv1"]);
  });

  it("returns nothing when pvMap is absent", () => {
    expect(mapPvStrings(inverter({ pvMap: null }), 1)).toEqual([]);
  });
});

describe("mapBatteryState", () => {
  it("prefers the plant's configured capacity", () => {
    const state = mapBatteryState(battery({ batterySOC: 50 }), 10);
    expect(state?.capacityKwh).toBe(10);
    expect(state?.storedKwh).toBe(5);
  });

  it("infers capacity from remaining energy when the plant reports none", () => {
    const state = mapBatteryState(
      battery({ batterySOC: 50, batteryRemainings: 5 }),
      null,
    );
    expect(state?.capacityKwh).toBe(10);
  });

  it("does not infer capacity from a near-empty battery", () => {
    // 0.1 kWh at 2% would imply 5 kWh, but rounding dominates down there.
    const state = mapBatteryState(
      battery({ batterySOC: 2, batteryRemainings: 0.1 }),
      null,
    );
    expect(state?.capacityKwh).toBe(0);
  });

  it("returns null without an SOC, rather than a zeroed battery", () => {
    expect(mapBatteryState(battery({ batterySOC: null }), 10)).toBeNull();
  });
});

describe("mapInverterState", () => {
  it("names a documented status code", () => {
    expect(mapInverterState(inverter({ deviceStatus: 102 }), 1).status).toBe("Normal");
  });

  it("degrades gracefully on an undocumented code", () => {
    expect(mapInverterState(inverter({ deviceStatus: 999 }), 1).status).toBe(
      "Estado 999",
    );
  });

  it("collects only the phases that reported", () => {
    const state = mapInverterState(
      inverter({ acPower1: 2200, acPower2: null, acPower3: null }),
      1,
    );
    expect(state.acPowerByPhase).toEqual([2200]);
  });
});

describe("mapTopology", () => {
  const plant = plantInfoSchema.parse({
    plantId: 339663000000618,
    plantName: "Casa",
    pvCapacity: 8.2,
    batteryCapacity: 10,
    electricityPriceUnit: "MXN",
    plantTimeZone: "(UTC-06:00)Guadalajara, Mexico City",
  });

  it("detects a CT even though it is not a device", () => {
    const topology = mapTopology({
      plant,
      inverters: [],
      meters: [],
      samples: [inverter({ gridPower: -800 })],
      businessType: 1,
    });
    expect(topology.hasGridMetering).toBe(true);
  });

  it("reports no metering when neither a meter nor a CT reports", () => {
    const topology = mapTopology({
      plant,
      inverters: [],
      meters: [],
      samples: [
        inverter({
          gridPower: null,
          totalImportEnergy: null,
          totalExportEnergy: null,
        }),
      ],
      businessType: 1,
    });
    expect(topology.hasGridMetering).toBe(false);
  });

  it("counts PV strings from the sample", () => {
    const topology = mapTopology({
      plant,
      inverters: [],
      samples: [
        inverter({
          pvMap: { pv1Power: 1, pv2Power: 2, pv3Power: 3, pv4Power: 4, pv1Voltage: 5 },
        }),
      ],
      businessType: 1,
    });
    expect(topology.pvStringCount).toBe(4);
  });

  it("treats a zero configured capacity as unknown, not as zero", () => {
    const unconfigured = plantInfoSchema.parse({
      plantId: "1",
      pvCapacity: 0,
      batteryCapacity: 0,
    });
    const topology = mapTopology({
      plant: unconfigured,
      inverters: [],
      businessType: 1,
    });
    expect(topology.pvCapacityKwp).toBeNull();
    expect(topology.batteryCapacityKwh).toBeNull();
  });
});

describe("unwrapEnvelope", () => {
  it("unwraps a successful business response", () => {
    expect(unwrapEnvelope({ code: 10000, result: { ok: true } })).toEqual({ ok: true });
  });

  it("uses code 0 for the auth endpoint", () => {
    expect(unwrapEnvelope({ code: 0, result: { access_token: "t" } }, 0)).toEqual({
      access_token: "t",
    });
  });

  it("flags a rate limit as retryable", () => {
    try {
      unwrapEnvelope({ code: 10406, message: "too fast" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SolaxError);
      expect((error as SolaxError).isRateLimit).toBe(true);
      expect((error as SolaxError).retryable).toBe(true);
    }
  });

  it("flags an exhausted quota as NOT retryable", () => {
    try {
      unwrapEnvelope({ code: 10405 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as SolaxError).isQuotaExhausted).toBe(true);
      expect((error as SolaxError).retryable).toBe(false);
    }
  });

  it("flags an invalid token as an auth problem worth one retry", () => {
    try {
      unwrapEnvelope({ code: 10402 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as SolaxError).isAuthProblem).toBe(true);
    }
  });

  it("rejects a response that is not the documented envelope", () => {
    expect(() => unwrapEnvelope({ unexpected: true })).toThrow(/documented envelope/);
  });
});

describe("history across microinverters", () => {
  const at = (sn: string, time: string, watts: number) =>
    inverter({ deviceSn: sn, plantLocalTime: time, MPPTTotalInputPower: watts });
  const options = { businessType: 1 as const, utcOffsetMinutes: -360, intervalMinutes: 5 };

  it("sums every unit in the same slot into one point", () => {
    const series = mapAggregateHistory(
      [
        at("MICRO-1", "2026-09-18 12:00:00", 2100),
        at("MICRO-2", "2026-09-18 12:00:00", 2200),
        at("MICRO-3", "2026-09-18 12:00:00", 2150),
      ],
      options,
    );
    expect(series).toHaveLength(1);
    expect(series[0]?.pv).toBe(6450);
    expect(series[0]?.at.toISOString()).toBe("2026-09-18T18:00:00.000Z");
  });

  it("orders slots in time even when units arrive one after another", () => {
    const series = mapAggregateHistory(
      [
        at("MICRO-1", "2026-09-18 12:05:00", 100),
        at("MICRO-1", "2026-09-18 12:00:00", 100),
        at("MICRO-2", "2026-09-18 12:00:00", 200),
        at("MICRO-2", "2026-09-18 12:05:00", 200),
      ],
      options,
    );
    expect(series.map((s) => s.pv)).toEqual([300, 300]);
    expect(series[0]!.at < series[1]!.at).toBe(true);
  });
});
