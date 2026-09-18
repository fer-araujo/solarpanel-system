import { useMemo, useState } from "react";
import { scaleLinear } from "d3-scale";
import type { PlantStatEntry } from "@/api/client";
import { ChartTooltip, TooltipRow } from "@/ui/primitives/ChartTooltip";
import { useMeasuredWidth } from "./useMeasuredWidth";

/**
 * Energy per bucket: days of a month, months of a year, or years.
 * Import/export series only appear when the hardware reported them.
 */

const M = { top: 18, right: 14, bottom: 38, left: 46 };
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const SERIES = [
  { key: "pvGeneration", label: "Generado", color: "var(--color-solar)" },
  { key: "importEnergy", label: "Importado", color: "var(--color-grid)" },
  { key: "exportEnergy", label: "Exportado", color: "var(--color-batt)" },
] as const;

const monthLabel = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1] ?? date;

export function MonthlyEnergy({
  entries,
  label = monthLabel,
}: {
  entries: PlantStatEntry[];
  label?: (date: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [measureRef, W] = useMeasuredWidth(900);
  const H = W < 640 ? 200 : 260;

  const series = useMemo(
    () => SERIES.filter((s) => entries.some((e) => e[s.key] !== null && e[s.key] !== undefined && (e[s.key] ?? 0) > 0)),
    [entries],
  );
  const peak = useMemo(
    () => Math.max(1, ...entries.flatMap((e) => series.map((s) => e[s.key] ?? 0))),
    [entries, series],
  );

  if (entries.length === 0 || series.length === 0) {
    return <p className="py-10 text-center text-[13px] text-ink-faint">Sin generación registrada en este periodo.</p>;
  }

  const slotW = (W - M.left - M.right) / entries.length;
  const y = scaleLinear().domain([0, peak * 1.08]).range([H - M.bottom, M.top]);
  const barW = Math.max(3, (slotW * 0.75) / series.length - 2);
  // Keep labels ~30px apart so days of a month do not collide on a phone.
  const labelStep = Math.max(1, Math.ceil(30 / slotW));
  const total = entries.reduce((sum, e) => sum + (e.pvGeneration ?? 0), 0);
  const active = hover === null ? null : entries[hover];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-5 text-[12px] text-ink-dim">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className="ml-auto">
          Total <span className="tnum text-solar">{total.toFixed(1)} kWh</span>
        </span>
      </div>

      <div ref={measureRef} className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" onMouseLeave={() => setHover(null)}>
          <title>Energía por periodo</title>
          {y.ticks(4).map((tick) => (
            <g key={tick}>
              <line x1={M.left} x2={W - M.right} y1={y(tick)} y2={y(tick)} stroke="var(--color-line)" strokeOpacity="0.45" />
              <text x={M.left - 8} y={y(tick) + 4} textAnchor="end" className="tnum" fontSize="11" fill="var(--color-ink-faint)">
                {tick >= 1000 ? `${(tick / 1000).toFixed(1)}k` : tick.toFixed(0)}
              </text>
            </g>
          ))}
          {entries.map((entry, i) => {
            const x0 = M.left + i * slotW;
            return (
              <g key={entry.date} onMouseEnter={() => setHover(i)}>
                <rect x={x0} y={M.top} width={slotW} height={H - M.bottom - M.top}
                  fill={hover === i ? "var(--color-raised)" : "transparent"} fillOpacity="0.6" />
                {series.map((s, si) => {
                  const v = entry[s.key] ?? 0;
                  return (
                    <rect key={s.key} x={x0 + slotW * 0.125 + si * (barW + 2)} y={y(v)} width={barW}
                      height={Math.max(0, y(0) - y(v))} rx="2" fill={s.color}
                      fillOpacity={hover === null || hover === i ? 0.9 : 0.4} />
                  );
                })}
                {i % labelStep === 0 && (
                  <text x={x0 + slotW / 2} y={H - 16} textAnchor="middle" fontSize="11" fill="var(--color-ink-faint)">
                    {label(entry.date)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {active && hover !== null && (
          <ChartTooltip xPct={((M.left + (hover + 0.5) * slotW) / W) * 100}>
            <p className="tnum mb-1 font-medium text-ink">{active.date}</p>
            {series.map((s) => (
              <TooltipRow key={s.key} label={s.label} value={`${(active[s.key] ?? 0).toFixed(1)} kWh`} color={s.color} />
            ))}
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}
