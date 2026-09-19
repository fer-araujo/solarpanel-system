/**
 * Instantaneous solar power against installed capacity.
 *
 * The number that matters at a glance: how hard the roof is working right now,
 * as a share of what it can do. Ticks every 10% of capacity.
 */

const START = -225;
const SWEEP = 270;
const R = 86;
const THICK = 12;

function polar(deg: number, radius: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad) * radius, Math.sin(rad) * radius];
}

function arc(from: number, to: number, radius: number): string {
  const [x1, y1] = polar(from, radius);
  const [x2, y2] = polar(to, radius);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
}

export function PowerGauge({
  watts,
  capacityKwp,
  caption,
}: {
  watts: number;
  capacityKwp: number | null;
  caption?: string;
}) {
  const max = (capacityKwp ?? 7) * 1000;
  const share = Math.max(0, Math.min(1, watts / max));
  const end = START + SWEEP * share;

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="-120 -120 240 205" className="w-full max-w-[190px] sm:max-w-[260px]" role="img">
        <title>Potencia solar actual</title>
        <defs>
          <linearGradient id="pvGauge" x1="0" y1="1" x2="1" y2="0">
            {/* Subtle but visible: deeper emerald lifting into the light one. */}
            <stop offset="0%" stopColor="#0b8a62" />
            <stop offset="55%" stopColor="var(--color-solar)" />
            <stop offset="100%" stopColor="var(--color-solar-lift)" />
          </linearGradient>
        </defs>

        {Array.from({ length: 41 }, (_, i) => {
          const deg = START + (SWEEP * i) / 40;
          const major = i % 4 === 0;
          const [x1, y1] = polar(deg, R + THICK / 2 + 5);
          const [x2, y2] = polar(deg, R + THICK / 2 + (major ? 13 : 9));
          return (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={deg <= end ? "var(--color-solar)" : "var(--color-line)"}
              strokeOpacity={major ? 0.9 : 0.5} strokeWidth={major ? 1.4 : 1} />
          );
        })}

        <path d={arc(START, START + SWEEP, R)} fill="none" stroke="var(--color-line)"
          strokeOpacity="0.55" strokeWidth={THICK} strokeLinecap="round" />
        {share > 0.002 && (
          <path d={arc(START, end, R)} fill="none" stroke="url(#pvGauge)"
            strokeWidth={THICK} strokeLinecap="round" />
        )}

        <text y="4" textAnchor="middle" className="tnum" fontSize="46" fontWeight="500" fill="var(--color-ink)">
          {(watts / 1000).toFixed(2)}
        </text>
        <text y="26" textAnchor="middle" fontSize="13" fill="var(--color-ink-dim)">kW</text>
        <text y="50" textAnchor="middle" fontSize="12" fill="var(--color-ink-faint)">
          {Math.round(share * 100)}% de {capacityKwp ?? "—"} kWp
        </text>
      </svg>
      {caption && <p className="-mt-2 text-[12px] text-ink-faint">{caption}</p>}
    </div>
  );
}
