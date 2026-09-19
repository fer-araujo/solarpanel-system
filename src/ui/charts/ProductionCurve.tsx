import { useMemo, useState } from "react";
import { scaleLinear } from "d3-scale";
import { area, line, curveMonotoneX } from "d3-shape";
import { splitLoadSources } from "@core/energy/services/derive-load";
import type { PowerSnapshot } from "@core/energy/model/power";
import { estimatedLoadAt } from "@core/energy/services/load-profile";
import { ChartTooltip, TooltipRow } from "@/ui/primitives/ChartTooltip";
import { useMeasuredWidth } from "./useMeasuredWidth";

/**
 * The day's curve.
 *
 * METERED: areas stack by the origin of every watt the house used (solar
 * direct, battery, grid). PRODUCTION ONLY (no meter): the house load is
 * unknowable, so it shows production honestly instead of a load line at zero.
 *
 * The readout floats next to the cursor so the eye never leaves the data.
 */

/** Below this width the chart gets shorter and its hour axis sparser. */
const NARROW = 640;
const M = { top: 16, right: 16, bottom: 30, left: 44 };

interface Band {
  minute: number;
  lo: number;
  hi: number;
}

interface Point {
  minute: number;
  pv: number;
  load: number | null;
  fromPv: number;
  fromBattery: number;
  fromGrid: number;
}

const SOURCES = [
  { key: "fromPv", label: "Solar directo", color: "var(--color-solar)" },
  { key: "fromBattery", label: "Batería", color: "var(--color-batt)" },
  { key: "fromGrid", label: "Red", color: "var(--color-grid)" },
] as const;

const minuteOf = (at: Date) => at.getHours() * 60 + at.getMinutes();
const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(Math.round(minute % 60)).padStart(2, "0")}`;
const kw = (w: number) => `${(w / 1000).toFixed(2)} kW`;

export function ProductionCurve({
  samples,
  estimatedLoad = [],
}: {
  samples: PowerSnapshot[];
  /**
   * Hourly estimated house load (24 values, watts) from the bill history.
   * Drawn only when there is no meter, dashed and labelled as an estimate.
   */
  estimatedLoad?: readonly number[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [measureRef, W] = useMeasuredWidth(1000);
  const narrow = W < NARROW;
  const H = Math.round(Math.min(320, Math.max(170, W * 0.5)));

  const points = useMemo<Point[]>(
    () =>
      samples.map((sample) => {
        const split = splitLoadSources(sample.pv, sample.battery, sample.grid);
        return {
          minute: minuteOf(sample.at),
          pv: sample.pv,
          load: sample.load,
          fromPv: split?.fromPv ?? 0,
          fromBattery: split?.fromBattery ?? 0,
          fromGrid: split?.fromGrid ?? 0,
        };
      }),
    [samples],
  );

  const metered = useMemo(() => points.some((p) => p.load !== null), [points]);
  const estimate = useMemo(
    () =>
      !metered && estimatedLoad.length === 24
        ? Array.from({ length: 97 }, (_, i) => ({ minute: i * 15, watts: estimatedLoadAt(estimatedLoad, i * 15) ?? 0 }))
        : [],
    [metered, estimatedLoad],
  );
  const peak = useMemo(
    () =>
      Math.max(
        1000,
        ...points.map((p) => Math.max(p.pv, p.load ?? 0)),
        ...estimate.map((e) => e.watts),
      ),
    [points, estimate],
  );

  const x = scaleLinear().domain([0, 1440]).range([M.left, W - M.right]);
  const y = scaleLinear().domain([0, peak * 1.1]).range([H - M.bottom, M.top]);

  const bands = useMemo(() => {
    if (!metered) return [];
    let acc = new Array<number>(points.length).fill(0);
    return SOURCES.map((source) => {
      const data: Band[] = points.map((p, i) => {
        const lo = acc[i] ?? 0;
        return { minute: p.minute, lo, hi: lo + p[source.key] };
      });
      acc = data.map((b) => b.hi);
      return { ...source, data };
    });
  }, [points, metered]);

  const bandPath = area<Band>().x((d) => x(d.minute)).y0((d) => y(d.lo)).y1((d) => y(d.hi)).curve(curveMonotoneX);
  const pvArea = area<Point>().x((d) => x(d.minute)).y0(y(0)).y1((d) => y(d.pv)).curve(curveMonotoneX);
  const pvLine = line<Point>().x((d) => x(d.minute)).y((d) => y(d.pv)).curve(curveMonotoneX);
  const estimateLine = line<{ minute: number; watts: number }>()
    .x((d) => x(d.minute))
    .y((d) => y(d.watts))
    .curve(curveMonotoneX);

  const active = hover === null ? null : points[hover];
  const peakPoint = points.reduce<Point | null>((top, p) => (!top || p.pv > top.pv ? p : top), null);

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    if (points.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minute = x.invert(((event.clientX - rect.left) / rect.width) * W);
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    points.forEach((p, i) => {
      const distance = Math.abs(p.minute - minute);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    setHover(best);
  }

  if (points.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-ink-faint">
        Sin lecturas para este día. El dongle sube datos cada ~5 minutos.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-ink-dim">
        {metered ? (
          SOURCES.map((s) => (
            <span key={s.key} className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))
        ) : (
          <>
            <span className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-solar" />
              Producción solar
            </span>
            {estimate.length > 0 && (
              <span className="flex items-center gap-2" title="Estimado con tu consumo típico de los recibos CFE">
                <span className="inline-block w-3 border-t-2 border-dashed border-grid" />
                Consumo estimado
              </span>
            )}
          </>
        )}
        {peakPoint && peakPoint.pv > 0 && (
          <span className="ml-auto text-ink-faint">
            Pico <span className="tnum text-solar">{kw(peakPoint.pv)}</span> a las{" "}
            <span className="tnum text-ink">{hhmm(peakPoint.minute)}</span>
          </span>
        )}
      </div>

      <div ref={measureRef} className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full cursor-crosshair" onMouseMove={onMove}
          onMouseLeave={() => setHover(null)} role="img">
          <title>Curva de generación del día</title>
          <defs>
            <linearGradient id="g-pvonly" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-solar)" stopOpacity="0.5" />
              <stop offset="100%" stopColor="var(--color-solar)" stopOpacity="0.04" />
            </linearGradient>
            {SOURCES.map((s) => (
              <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.55" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0.06" />
              </linearGradient>
            ))}
          </defs>

          {y.ticks(5).map((tick) => (
            <g key={tick}>
              <line x1={M.left} x2={W - M.right} y1={y(tick)} y2={y(tick)} stroke="var(--color-line)" strokeOpacity="0.45" />
              <text x={M.left - 9} y={y(tick) + 4} textAnchor="end" className="tnum" fontSize="11" fill="var(--color-ink-faint)">
                {(tick / 1000).toFixed(1)}
              </text>
            </g>
          ))}
          <text x={M.left - 9} y={M.top - 4} textAnchor="end" fontSize="10" fill="var(--color-ink-faint)">kW</text>
          {(narrow ? [0, 360, 720, 1080, 1440] : [0, 180, 360, 540, 720, 900, 1080, 1260, 1440]).map((tick) => (
            <text key={tick} x={x(tick)} y={H - 9} textAnchor="middle" className="tnum" fontSize="11" fill="var(--color-ink-faint)">
              {hhmm(tick)}
            </text>
          ))}

          {metered
            ? bands.map((b) => (
                <path key={b.key} d={bandPath(b.data) ?? undefined} fill={`url(#g-${b.key})`} stroke={b.color} strokeWidth="1" strokeOpacity="0.7" />
              ))
            : <path d={pvArea(points) ?? undefined} fill="url(#g-pvonly)" />}

          <path d={pvLine(points) ?? undefined} fill="none" stroke="var(--color-solar-lift)" strokeWidth="1.8" />

          {estimate.length > 0 && (
            <path d={estimateLine(estimate) ?? undefined} fill="none" stroke="var(--color-grid)"
              strokeWidth="1.6" strokeDasharray="5 4" strokeOpacity="0.85" />
          )}

          {active && (
            <g>
              <line x1={x(active.minute)} x2={x(active.minute)} y1={M.top} y2={H - M.bottom}
                stroke="var(--color-ink-dim)" strokeOpacity="0.5" strokeDasharray="3 3" />
              <circle cx={x(active.minute)} cy={y(active.pv)} r="5" fill="var(--color-void)" stroke="var(--color-solar)" strokeWidth="2" />
              {active.load !== null && (
                <circle cx={x(active.minute)} cy={y(active.load)} r="4" fill="var(--color-ink)" />
              )}
            </g>
          )}
        </svg>

        {active && (
          <ChartTooltip xPct={(x(active.minute) / W) * 100}>
            <p className="tnum mb-1 font-medium text-ink">{hhmm(active.minute)}</p>
            <TooltipRow label="Producción" value={kw(active.pv)} color="var(--color-solar)" />
            {active.load === null ? (
              estimate.length > 0 ? (
                <>
                  <TooltipRow label="Consumo est." value={kw(estimatedLoadAt(estimatedLoad, active.minute) ?? 0)}
                    color="var(--color-grid)" />
                  <p className="mt-1 text-[11px] text-ink-faint">Estimado con tus recibos CFE</p>
                </>
              ) : (
                <p className="mt-1 text-[11px] text-ink-faint">Casa y red: sin medir</p>
              )
            ) : (
              <>
                <TooltipRow label="Consumo" value={kw(active.load)} color="var(--color-ink)" />
                <TooltipRow label="Batería" value={kw(active.fromBattery)} color="var(--color-batt)" />
                <TooltipRow label="Red" value={kw(active.fromGrid)} color="var(--color-grid)" />
              </>
            )}
          </ChartTooltip>
        )}
      </div>
    </div>
  );
}
