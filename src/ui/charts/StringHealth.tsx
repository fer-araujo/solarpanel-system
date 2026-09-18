import type { PvStringReading } from "@core/energy/model/power";

/**
 * Compares each PV string against the group mean. A string drifting well below
 * its siblings is the cheapest early signal of shading or a panel that needs
 * cleaning — the official app shows the raw numbers but never the comparison.
 */

const WARN_THRESHOLD = -10;

export function StringHealth({ strings }: { strings: PvStringReading[] }) {
  if (strings.length === 0) {
    return (
      <p className="py-6 text-center text-[13px] text-ink-faint">
        El inversor no reportó ramales individuales.
      </p>
    );
  }

  const mean =
    strings.reduce((sum, s) => sum + s.watts, 0) / Math.max(strings.length, 1);
  const max = Math.max(...strings.map((s) => s.watts), 1);
  const worst = [...strings].sort((a, b) => a.watts - b.watts)[0];

  const worstDelta = worst ? ((worst.watts - mean) / mean) * 100 : 0;
  const flagged = worstDelta < WARN_THRESHOLD;

  return (
    <div>
      <div className="space-y-3">
        {strings.map((s) => {
          const delta = ((s.watts - mean) / mean) * 100;
          const low = delta < WARN_THRESHOLD;
          return (
            <div key={s.id}>
              <div className="mb-1.5 flex items-baseline justify-between text-[12px]">
                <span className={low ? "text-alert" : "text-ink-dim"}>{s.label}</span>
                <span className="flex items-baseline gap-2.5">
                  <span className="tnum text-[13px] text-ink">
                    {(s.watts / 1000).toFixed(2)} kW
                  </span>
                  <span
                    className={`tnum w-12 text-right text-[11.5px] ${
                      low ? "text-alert" : delta > 0 ? "text-solar" : "text-ink-faint"
                    }`}
                  >
                    {delta > 0 ? "+" : ""}
                    {delta.toFixed(1)}%
                  </span>
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-line/60">
                <div
                  className={`h-full rounded-full ${low ? "bg-alert" : "bg-solar"}`}
                  style={{ width: `${(s.watts / max) * 100}%` }}
                />
              </div>
              <p className="tnum mt-1 text-[11px] text-ink-faint">
                {s.volts === null ? "—" : s.volts.toFixed(0)} V ·{" "}
                {s.amps === null ? "—" : s.amps.toFixed(1)} A
              </p>
            </div>
          );
        })}
      </div>

      <div
        className={`mt-4 rounded-lg border px-3.5 py-2.5 text-[12px] leading-relaxed ${
          flagged
            ? "border-alert/30 bg-alert/8 text-ink-dim"
            : "border-line/50 bg-raised/50 text-ink-faint"
        }`}
      >
        {flagged && worst ? (
          <>
            <span className="text-alert">{worst.label}</span> va{" "}
            <span className="tnum text-alert">{Math.abs(worstDelta).toFixed(0)}%</span> por
            debajo del promedio. A esta hora del día eso suele ser sombra parcial o polvo
            en ese panel.
          </>
        ) : (
          "Todos los paneles están dentro del 10% del promedio. Sin señales de sombra ni suciedad."
        )}
      </div>
    </div>
  );
}
