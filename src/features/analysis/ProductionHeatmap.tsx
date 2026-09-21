import { useCallback, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/api/client";
import { queryKeys, statsStaleTime } from "@/api/queries";
import { Card } from "@/ui/primitives/Card";

/**
 * Daily production drawn like GitHub's contribution calendar, measured from
 * github.com: 12px square cells (GitHub uses 11), 2px radius, 4px spacing, flat colours on a
 * five-step scale, 12px labels, one column per week and one row per weekday.
 * The calendar keeps that fixed size; the rest of the card holds a summary,
 * the way GitHub puts the year list beside it.
 *
 * Only months since installation are fetched (1 stats call each, cached for an
 * hour and shared with the Mes view).
 */

const WEEKS = 53;
const CELL = 12;
const GAP = 4;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS = ["", "lun", "", "mié", "", "vie", ""];

/** GitHub's luminance steps in the app's green; level 0 is GitHub's empty cell. */
const LEVELS = [
  "#151b23",
  "hsl(142 80% 13%)",
  "hsl(142 62% 26%)",
  "hsl(142 60% 37%)",
  "hsl(142 72% 45%)",
] as const;

/** Quartiles of the best day: 0 (nothing produced) to 4 (near the best). */
const levelOf = (kwh: number | undefined, max: number) =>
  kwh === undefined || kwh <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((kwh / max) * 4)));

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthName = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1] ?? "";
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${monthName(iso)}`;

interface Day {
  date: string;
  future: boolean;
}

function Summary({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.08em] text-ink-faint uppercase">{label}</p>
      <p className="tnum mt-1 text-[20px] leading-none font-medium text-ink">
        {value}
        {unit && <span className="ml-1 text-[12px] font-normal text-ink-faint">{unit}</span>}
      </p>
    </div>
  );
}

export function ProductionHeatmap({ installedAt }: { installedAt: string | null }) {
  const firstDay = installedAt && /^\d{4}-\d{2}-\d{2}/.test(installedAt) ? installedAt.slice(0, 10) : null;

  /** 53 weeks × 7 days, Sunday first, ending with the current week. */
  const weeks = useMemo(() => {
    const today = new Date();
    const todayIso = isoDay(today);
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - (WEEKS - 1) * 7);
    return Array.from({ length: WEEKS }, (_, w) =>
      Array.from({ length: 7 }, (_, d): Day => {
        const iso = isoDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d));
        return { date: iso, future: iso > todayIso };
      }),
    );
  }, []);

  /** A month's name sits over the first week that starts inside it (as GitHub does). */
  const monthLabels = useMemo(
    () =>
      weeks.map((week, w) => {
        const month = week[0]!.date.slice(0, 7);
        const previous = w > 0 ? weeks[w - 1]![0]!.date.slice(0, 7) : null;
        // The first column's label is dropped when the next month starts right
        // after it, so the two names never overlap.
        const next = weeks[w + 1]?.[0]?.date.slice(0, 7);
        if (w === 0 && next !== month) return "";
        return month !== previous ? monthName(week[0]!.date) : "";
      }),
    [weeks],
  );

  const months = useMemo(() => {
    const keys = new Set<string>();
    for (const week of weeks) {
      for (const day of week) {
        const month = day.date.slice(0, 7);
        if (!day.future && (!firstDay || month >= firstDay.slice(0, 7))) keys.add(month);
      }
    }
    return [...keys];
  }, [weeks, firstDay]);

  const queries = useQueries({
    queries: months.map((month) => ({
      queryKey: queryKeys.statsMonth(month),
      queryFn: () => api.statsMonth(month),
      staleTime: statsStaleTime(month),
    })),
  });

  const byDay = new Map<string, number>();
  for (const query of queries) {
    for (const entry of query.data?.plantEnergyStatDataList ?? []) {
      const kwh = entry.pvGeneration ?? entry.inverterACOutputEnergy;
      if (kwh !== null && kwh !== undefined && kwh > 0) byDay.set(entry.date.slice(0, 10), kwh);
    }
  }
  const values = [...byDay.values()];
  const max = Math.max(0, ...values);
  const total = values.reduce((sum, kwh) => sum + kwh, 0);
  const best = [...byDay.entries()].find(([, kwh]) => kwh === max)?.[0] ?? null;
  const loading = queries.some((q) => q.isPending);

  const [selected, setSelected] = useState<string | null>(null);

  // On a phone the calendar scrolls sideways; start at the current week.
  const scrollToEnd = useCallback((element: HTMLDivElement | null) => {
    if (element) element.scrollLeft = element.scrollWidth;
  }, []);

  const describe = (date: string) => {
    const kwh = byDay.get(date);
    return kwh === undefined ? `${shortDate(date)} · sin producción` : `${shortDate(date)} · ${kwh.toFixed(1)} kWh`;
  };

  const columns = `28px repeat(${WEEKS}, ${CELL}px)`;

  return (
    <Card title={`${total.toFixed(0)} kWh generados en el último año`}>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="min-w-0">
          <div ref={scrollToEnd} className="overflow-x-auto">
            <div className="w-max" onMouseLeave={() => setSelected(null)}>
              <div className="grid" style={{ gridTemplateColumns: columns, columnGap: GAP }}>
                <span />
                {monthLabels.map((label, w) => (
                  <span key={w} className="overflow-visible whitespace-nowrap text-[12px] leading-[18px] text-ink-dim">
                    {label}
                  </span>
                ))}
              </div>

              <div
                className="grid"
                style={{ gridTemplateColumns: columns, gridAutoRows: `${CELL}px`, gap: GAP }}
              >
                {WEEKDAYS.map((weekday, d) => (
                  <div key={d} className="contents">
                    <span className="self-center text-[12px] leading-none text-ink-dim">{weekday}</span>
                    {weeks.map((week) => {
                      const day = week[d]!;
                      if (day.future) return <span key={day.date} />;
                      return (
                        <button
                          key={day.date}
                          type="button"
                          aria-label={describe(day.date)}
                          onMouseEnter={() => setSelected(day.date)}
                          onClick={() => setSelected(day.date)}
                          className={`rounded-[2px] outline-offset-[-1px] ${loading ? "skeleton" : ""} ${
                            selected === day.date ? "outline outline-1 outline-ink/70" : ""
                          }`}
                          style={loading ? undefined : { background: LEVELS[levelOf(byDay.get(day.date), max)] }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-2 flex items-center justify-between gap-4 text-[12px] text-ink-faint">
            <span className="tnum text-ink-dim">{selected ? describe(selected) : "Pasa o toca un día"}</span>
            <span className="flex items-center gap-[3px]">
              <span className="mr-1">Menos</span>
              {LEVELS.map((color) => (
                <span key={color} className="inline-block rounded-[2px]" style={{ width: CELL, height: CELL, background: color }} />
              ))}
              <span className="ml-1">Más</span>
            </span>
          </div>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-5 border-line/50 lg:border-l lg:pl-6">
          <Summary label="Mejor día" value={max > 0 ? max.toFixed(1) : "—"} unit={best ? `kWh · ${shortDate(best)}` : undefined} />
          <Summary label="Promedio" value={values.length > 0 ? (total / values.length).toFixed(1) : "—"} unit="kWh/día" />
          <Summary label="Días generando" value={String(values.length)} />
          <Summary label="Total" value={total.toFixed(0)} unit="kWh" />
        </div>
      </div>
    </Card>
  );
}
