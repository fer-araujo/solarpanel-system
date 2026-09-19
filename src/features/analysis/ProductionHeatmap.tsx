import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/api/client";
import { queryKeys } from "@/api/queries";
import { Card } from "@/ui/primitives/Card";
import { Bone } from "@/ui/primitives/Skeleton";

/**
 * Daily production as a calendar: one row per month, one cell per day.
 *
 * GitHub-style: four discrete greens on a dark grid, so good and bad days
 * stand out at a glance. A day with no data keeps the empty cell and says so
 * on tap, rather than being coloured as a zero.
 *
 * Reuses the month stats queries (1 call per month, cached for an hour), so it
 * shares cache with the Mes view of the analysis chart.
 */

const MAX_MONTHS = 12;
/** Empty cell, then four levels of the accent over the page background. */
const LEVELS = [
  "var(--color-raised)",
  "color-mix(in oklab, var(--color-solar) 28%, var(--color-void))",
  "color-mix(in oklab, var(--color-solar) 50%, var(--color-void))",
  "color-mix(in oklab, var(--color-solar) 75%, var(--color-void))",
  "var(--color-solar)",
] as const;

/** Quartiles of the best day: 0 (nothing produced) to 4 (near the best). */
const levelOf = (kwh: number, max: number) =>
  kwh <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((kwh / max) * 4)));

/** Fixed GitHub-sized cells: small squares, not stretched to the card. */
const CELL = 13;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function monthsBetween(first: Date, last: Date): string[] {
  const list: string[] = [];
  const cursor = new Date(first.getFullYear(), first.getMonth(), 1);
  while (cursor <= last) {
    list.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return list.slice(-MAX_MONTHS);
}

type Cell =
  | { kind: "none" } // not a real day, before installation, or in the future
  | { kind: "gap"; date: string }
  | { kind: "value"; date: string; kwh: number };

export function ProductionHeatmap({ installedAt }: { installedAt: string | null }) {
  const today = isoDay(new Date());
  const firstDay = installedAt && /^\d{4}-\d{2}-\d{2}/.test(installedAt) ? installedAt.slice(0, 10) : null;
  const months = useMemo(() => {
    const now = new Date();
    const first = firstDay
      ? new Date(Number(firstDay.slice(0, 4)), Number(firstDay.slice(5, 7)) - 1, 1)
      : new Date(now.getFullYear(), now.getMonth() - (MAX_MONTHS - 1), 1);
    return monthsBetween(first, now);
  }, [firstDay]);

  const queries = useQueries({
    queries: months.map((month) => ({
      queryKey: queryKeys.statsMonth(month),
      queryFn: () => api.statsMonth(month),
      staleTime: 60 * 60 * 1000,
    })),
  });

  const [selected, setSelected] = useState<Exclude<Cell, { kind: "none" }> | null>(null);

  const { rows, max } = useMemo(() => {
    let peak = 0;
    const built = months.map((month, i) => {
      const byDay = new Map<string, number>();
      for (const entry of queries[i]?.data?.plantEnergyStatDataList ?? []) {
        const kwh = entry.pvGeneration ?? entry.inverterACOutputEnergy;
        if (kwh !== null && kwh !== undefined) byDay.set(entry.date.slice(0, 10), kwh);
      }
      const [y, m] = month.split("-").map(Number);
      const daysInMonth = new Date(y ?? 1970, m ?? 1, 0).getDate();
      const cells: Cell[] = DAYS.map((day) => {
        const date = `${month}-${pad(day)}`;
        if (day > daysInMonth || date > today || (firstDay && date < firstDay)) return { kind: "none" };
        const kwh = byDay.get(date);
        if (kwh === undefined) return { kind: "gap", date };
        peak = Math.max(peak, kwh);
        return { kind: "value", date, kwh };
      });
      return { month, cells, loading: queries[i]?.isPending ?? false };
    });
    return { rows: built, max: peak };
  }, [months, queries, today, firstDay]);

  const label = (month: string) => {
    const [y, m] = month.split("-");
    return `${MONTHS[Number(m) - 1]} ${y?.slice(2)}`;
  };

  const describe = (cell: Cell | null) => {
    if (!cell || cell.kind === "none") return null;
    const [, m, d] = cell.date.split("-");
    const day = `${Number(d)} ${MONTHS[Number(m) - 1]}`;
    return cell.kind === "gap" ? `${day} · sin datos del dongle` : `${day} · ${cell.kwh.toFixed(1)} kWh`;
  };

  return (
    <Card title="Producción diaria" hint="Cada celda es un día; toca una para ver su generación">
      {/* Scrolls sideways on a phone so every cell stays big enough to tap. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <div
        className="grid w-max gap-[3px]"
        style={{ gridTemplateColumns: `44px repeat(31, ${CELL}px)`, gridAutoRows: `${CELL}px` }}
        onMouseLeave={() => setSelected(null)}
      >
        {rows.map((row) => (
          <div key={row.month} className="contents">
            <span className="tnum self-center pr-1 text-[10.5px] text-ink-faint">{label(row.month)}</span>
            {row.loading
              ? DAYS.map((day) => <Bone key={day} className="rounded-[2px]" />)
              : row.cells.map((cell, i) => {
                  if (cell.kind === "none") return <span key={i} />;
                  const level = cell.kind === "value" ? levelOf(cell.kwh, max) : 0;
                  return (
                    <button
                      key={i}
                      type="button"
                      aria-label={describe(cell) ?? undefined}
                      onMouseEnter={() => setSelected(cell)}
                      onClick={() => setSelected(cell)}
                      className={`rounded-[2px] outline-offset-1 hover:outline hover:outline-1 hover:outline-ink-dim ${
                        selected?.date === cell.date ? "outline outline-1 outline-ink" : ""
                      }`}
                      style={{ background: LEVELS[level] }}
                    />
                  );
                })}
          </div>
        ))}

        <span />
        {DAYS.map((day) => (
          <span key={day} className="tnum text-center text-[9.5px] text-ink-faint">
            {day % 5 === 0 || day === 1 ? day : ""}
          </span>
        ))}
      </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-ink-faint">
        <span className="tnum min-h-[16px] text-ink-dim">{describe(selected) ?? " "}</span>
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
