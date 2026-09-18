import type { InverterState, PvStringReading } from "@core/energy/model/power";

/**
 * Per-unit view of a microinverter array.
 *
 * With three X1-Micro units a single aggregate status would hide one that is
 * down or running hot — which, on an array where each unit owns its own panels,
 * means a quarter of the roof silently stops earning. Production per unit comes
 * from grouping the string readings by device, since the string ids are scoped
 * by serial number.
 */

interface InverterFleetProps {
  inverters: InverterState[];
  strings: PvStringReading[];
}

export function InverterFleet({ inverters, strings }: InverterFleetProps) {
  const wattsBySerial = new Map<string, number>();
  for (const reading of strings) {
    const serial = reading.id.split(":")[0] ?? "";
    wattsBySerial.set(serial, (wattsBySerial.get(serial) ?? 0) + reading.watts);
  }

  const hottest = Math.max(
    ...inverters
      .map((unit) => unit.temperatureC)
      .filter((temp): temp is number => temp !== null),
    -Infinity,
  );

  return (
    <div className="space-y-2.5">
      {inverters.map((unit, index) => {
        // Per-panel readings when the unit reports them, its own total otherwise
        // (microinverters often leave pvMap empty).
        const watts = wattsBySerial.get(unit.serialNumber) ?? unit.pvWatts;
        const healthy = unit.status === "Normal";
        const runningHot =
          unit.temperatureC !== null &&
          inverters.length > 1 &&
          unit.temperatureC === hottest &&
          hottest > 55;

        return (
          <div
            key={unit.serialNumber}
            className="rounded-xl border border-line/50 bg-raised/50 px-3.5 py-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex items-center gap-2 text-[13px] text-ink">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    healthy ? "bg-solar" : "bg-alert"
                  }`}
                />
                Inversor {index + 1}
              </span>
              <span className="tnum text-[13px] text-ink">
                {`${(watts / 1000).toFixed(2)} kW`}
              </span>
            </div>

            <p className="tnum mt-1.5 text-[11px] text-ink-faint">
              {unit.serialNumber}
            </p>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
              <span className={healthy ? "text-ink-faint" : "text-alert"}>
                {unit.status}
              </span>
              {unit.ratedPowerKw !== null && (
                <span className="tnum text-ink-faint">{unit.ratedPowerKw} kW nom.</span>
              )}
              {unit.temperatureC !== null && (
                <span className={`tnum ${runningHot ? "text-grid" : "text-ink-faint"}`}>
                  {unit.temperatureC} °C
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
