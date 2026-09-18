interface RadialGaugeProps {
  soc: number;
  capacityKwh: number;
  /** Discharge floor configured on the inverter. */
  minSoc: number;
  /** Charge ceiling configured on the inverter. */
  maxSoc: number;
  flowWatts: number;
}

const START = -218;
const END = -322;
const R = 82;
const THICK = 13;

function polar(deg: number, radius: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad) * radius, Math.sin(rad) * radius];
}

function arcPath(fromDeg: number, toDeg: number, radius: number): string {
  const [x1, y1] = polar(fromDeg, radius);
  const [x2, y2] = polar(toDeg, radius);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const sweep = toDeg < fromDeg ? 0 : 1;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} ${sweep} ${x2} ${y2}`;
}

function atPercent(pct: number): number {
  return START + ((END - START) * pct) / 100;
}

export function RadialGauge({
  soc,
  capacityKwh,
  minSoc,
  maxSoc,
  flowWatts,
}: RadialGaugeProps) {
  const charging = flowWatts < -40;
  const discharging = flowWatts > 40;
  const stored = (capacityKwh * soc) / 100;

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="-110 -110 220 168" className="w-full max-w-[236px]" role="img">
        <title>Estado de carga de la batería</title>
        <defs>
          <linearGradient id="socFill" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--color-batt)" />
            <stop offset="55%" stopColor="var(--color-solar)" />
            <stop offset="100%" stopColor="var(--color-solar-lift)" />
          </linearGradient>
        </defs>

        <path
          d={arcPath(START, END, R)}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth={THICK}
          strokeLinecap="round"
          strokeOpacity="0.55"
        />
        <path
          d={arcPath(START, atPercent(soc), R)}
          fill="none"
          stroke="url(#socFill)"
          strokeWidth={THICK}
          strokeLinecap="round"
        />

        {[minSoc, maxSoc].map((mark) => {
          const [ix, iy] = polar(atPercent(mark), R - THICK / 2 - 3);
          const [ox, oy] = polar(atPercent(mark), R + THICK / 2 + 3);
          return (
            <line
              key={mark}
              x1={ix}
              y1={iy}
              x2={ox}
              y2={oy}
              stroke="var(--color-ink-faint)"
              strokeWidth="1.2"
            />
          );
        })}

        <text
          y="-6"
          textAnchor="middle"
          className="tnum"
          fontSize="44"
          fontWeight="500"
          fill="var(--color-ink)"
        >
          {soc.toFixed(0)}
        </text>
        <text y="-6" x="40" fontSize="15" fill="var(--color-ink-dim)">
          %
        </text>
        <text
          y="18"
          textAnchor="middle"
          className="tnum"
          fontSize="13"
          fill="var(--color-ink-dim)"
        >
          {stored.toFixed(1)} / {capacityKwh} kWh
        </text>
        <text y="42" textAnchor="middle" fontSize="11.5" fill="var(--color-ink-faint)">
          {charging
            ? `cargando a ${(Math.abs(flowWatts) / 1000).toFixed(2)} kW`
            : discharging
              ? `descargando a ${(flowWatts / 1000).toFixed(2)} kW`
              : "en reposo"}
        </text>
      </svg>

      <div className="mt-1 flex w-full justify-between px-1 text-[11px] text-ink-faint">
        <span className="tnum">min {minSoc}%</span>
        <span className="tnum">máx {maxSoc}%</span>
      </div>
    </div>
  );
}
