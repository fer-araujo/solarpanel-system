import { useCallback, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/api/client";
import { queryKeys } from "@/api/queries";
import { Card } from "@/ui/primitives/Card";

/**
 * Daily production laid out like GitHub's contribution graph: one column per
 * week (the last 53), one row per weekday, four discrete greens.
 *
 * Only months since the plant was installed are fetched (1 stats call per
 * month, cached for an hour and shared with the Mes view); earlier days are
 * simply empty cells.
 */

const WEEKS = 53;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAYS = ["", "lun", "", "mié", "", "vie", ""];

/** Level colours: an empty cell, then four strengths of the accent. */
const BASES = [
  "var(--color-raised)",
  "color-mix(in oklab, var(--color-solar) 30%, var(--color-void))",
  "color-mix(in oklab, var(--color-solar) 52%, var(--color-void))",
  "color-mix(in oklab, var(--color-solar) 76%, var(--color-void))",
  "var(--color-solar)",
] as const;

/** Each filled cell catches light from its top-left corner. */
const LEVELS = BASES.map((base, level) =>
  level === 0
    ? base
    : `linear-gradient(135deg, color-mix(in oklab, ${base} 70%, var(--color-solar-lift)), ${base} 55%, color-mix(in oklab, ${base} 80%, var(--color-void)))`,
);

/** Row height: short, wide cells keep the card low while it spans the width. */
const ROW = 12;

/** Quartiles of the best day: 0 (nothing produced) to 4 (near the best). */
const levelOf = (kwh: number | undefined, max: number) =>
  kwh === undefined || kwh <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((kwh / max) * 4)));

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthName = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1] ?? "";
const isFirstOfMonth = (iso: string) => iso.endsWith("-01");

interface Day {
  date: string;
  future: boolean;
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

  /** A month's name sits over the week in which it begins. */
  const monthLabels = useMemo(
    () =>
      weeks.map((week, w) => {
        const first = week.find((day) => isFirstOfMonth(day.date));
        if (first) return monthName(first.date);
        const nextStartsMonth = weeks[1]?.some((day) => isFirstOfMonth(day.date)) ?? false;
        return w === 0 && !nextStartsMonth ? monthName(week[0]!.date) : "";
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
      staleTime: 60 * 60 * 1000,
    })),
  });

  const byDay = new Map<string, number>();
  for (const query of queries) {
    for (const entry of query.data?.plantEnergyStatDataList ?? []) {
      const kwh = entry.pvGeneration ?? entry.inverterACOutputEnergy;
      if (kwh !== null && kwh !== undefined) byDay.set(entry.date.slice(0, 10), kwh);
    }
  }
  const max = Math.max(0, ...byDay.values());
  const total = [...byDay.values()].reduce((sum, kwh) => sum + kwh, 0);
  const loading = queries.some((q) => q.isPending);

  const [selected, setSelected] = useState<string | null>(null);

  // On a phone the graph scrolls sideways; start at the current week.
  const scrollToEnd = useCallback((element: HTMLDivElement | null) => {
    if (element) element.scrollLeft = element.scrollWidth;
  }, []);

  const describe = (date: string | null) => {
    if (!date) return null;
    const kwh = byDay.get(date);
    const label = `${Number(date.slice(8, 10))} ${monthName(date)}`;
    return kwh === undefined || kwh <= 0 ? `${label} · sin producción` : `${label} · ${kwh.toFixed(1)} kWh`;
  };

  const columns = `28px repeat(${WEEKS}, minmax(0, 1fr))`;

  return (
    <Card
      title="Producción diaria"
      action={
        <span className="tnum text-[12px] text-ink-faint">
          <span className="text-solar">{total.toFixed(0)} kWh</span> en el último año
        </span>
      }
    >
      <div ref={scrollToEnd} className="overflow-x-auto pb-1">
        <div className="min-w-[560px]" onMouseLeave={() => setSelected(null)}>
          <div className="mb-1 grid gap-[3px]" style={{ gridTemplateColumns: columns }}>
            <span />
            {monthLabels.map((label, w) => (
              <span key={w} className="whitespace-nowrap text-[10.5px] leading-none text-ink-faint">
                {label}
              </span>
            ))}
          </div>

          <div className="grid gap-[3px]" style={{ gridTemplateColumns: columns, gridAutoRows: `${ROW}px` }}>
            {WEEKDAYS.map((weekday, d) => (
              <div key={d} className="contents">
                <span className="self-center text-[9.5px] leading-none text-ink-faint">{weekday}</span>
                {weeks.map((week) => {
                  const day = week[d]!;
                  if (day.future) return <span key={day.date} />;
                  const level = levelOf(byDay.get(day.date), max);
                  return (
                    <button
                      key={day.date}
                      type="button"
                      aria-label={describe(day.date) ?? undefined}
                      onMouseEnter={() => setSelected(day.date)}
                      onClick={() => setSelected(day.date)}
                      className={`rounded-[3px] ${loading ? "skeleton" : ""} ${
                        selected === day.date
                          ? "outline outline-1 outline-offset-1 outline-ink"
                          : "hover:outline hover:outline-1 hover:outline-ink-dim"
                      }`}
                      style={loading ? undefined : { background: LEVELS[level] }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-ink-faint">
        <span className="tnum min-h-[16px] text-ink-dim">
          {describe(selected) ?? "Toca un día para ver su generación"}
        </span>
        <span className="flex items-center gap-1">
          <span className="mr-1">menos</span>
          {LEVELS.map((color) => (
            <span key={color} className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: color }} />
          ))}
          <span className="ml-1">más{max > 0 ? ` · mejor día ${max.toFixed(0)} kWh` : ""}</span>
        </span>
      </div>
    </Card>
  );
}
