import { useMemo, useState } from "react";
/**
 * Day-level generation, one cell per day.
 *
 * Not on the dashboard yet: `get_stat_data` returns a whole year of MONTHS in
 * one call, but day-level data needs one call per month — twelve against a
 * quota-limited API. So this belongs behind an explicit user action, and
 * `MonthlyEnergy` covers the year view for free.
 */
export interface DailyEnergy {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  pvKwh: number;
}

const CELL = 12;
const GAP = 3;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DAYS = ["L", "", "M", "", "J", "", "S"];

interface Cell extends DailyEnergy {
  week: number;
  weekday: number;
  month: number;
}

/** Monday-first weekday index. */
function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function CalendarHeatmap({ days }: { days: DailyEnergy[] }) {
  const [hover, setHover] = useState<Cell | null>(null);

  const { cells, weeks, max, monthLabels } = useMemo(() => {
    const first = days[0];
    if (!first) return { cells: [] as Cell[], weeks: 0, max: 1, monthLabels: [] as { week: number; month: number }[] };

    const offset = weekdayIndex(new Date(`${first.date}T00:00:00`));
    const out: Cell[] = days.map((day, i) => {
      const date = new Date(`${day.date}T00:00:00`);
      const slot = i + offset;
      return {
        ...day,
        week: Math.floor(slot / 7),
        weekday: slot % 7,
        month: date.getMonth(),
      };
    });

    const labels: { week: number; month: number }[] = [];
    let seen = -1;
    for (const cell of out) {
      if (cell.month !== seen && cell.weekday <= 3) {
        labels.push({ week: cell.week, month: cell.month });
        seen = cell.month;
      }
    }

    return {
      cells: out,
      weeks: Math.max(...out.map((c) => c.week)) + 1,
      max: Math.max(...out.map((c) => c.pvKwh)),
      monthLabels: labels,
    };
  }, [days]);

  const width = weeks * (CELL + GAP) + 30;
  const height = 7 * (CELL + GAP) + 22;

  const total = useMemo(() => days.reduce((sum, d) => sum + d.pvKwh, 0), [days]);
  const best = useMemo(
    () => days.reduce((top, d) => (d.pvKwh > top.pvKwh ? d : top), days[0] ?? { date: "", pvKwh: 0 }),
    [days],
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[12px] text-ink-dim">
        <span>
          Total 12 meses <span className="tnum text-solar">{(total / 1000).toFixed(2)} MWh</span>
        </span>
        <span>
          Mejor día <span className="tnum text-ink">{best.pvKwh.toFixed(1)} kWh</span>
        </span>
      </div>

      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full min-w-[620px]" role="img">
          <title>Generación diaria de los últimos 12 meses</title>
          {DAYS.map((label, i) =>
            label ? (
              <text
                key={i}
                x="18"
                y={22 + i * (CELL + GAP) + CELL - 2.5}
                textAnchor="end"
                fontSize="9.5"
                fill="var(--color-ink-faint)"
              >
                {label}
              </text>
            ) : null,
          )}

          {monthLabels.map((label) => (
            <text
              key={`${label.week}-${label.month}`}
              x={30 + label.week * (CELL + GAP)}
              y="10"
              fontSize="9.5"
              fill="var(--color-ink-faint)"
            >
              {MONTHS[label.month]}
            </text>
          ))}

          {cells.map((cell) => {
            const t = cell.pvKwh / max;
            return (
              <rect
                key={cell.date}
                x={30 + cell.week * (CELL + GAP)}
                y={22 + cell.weekday * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx="2.5"
                fill="var(--color-solar)"
                fillOpacity={0.07 + t * 0.9}
                stroke={hover?.date === cell.date ? "var(--color-ink)" : "transparent"}
                strokeWidth="1"
                onMouseEnter={() => setHover(cell)}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </svg>
      </div>

      <div className="mt-2 flex min-h-[20px] items-center justify-between text-[12px]">
        <span className="text-ink-dim">
          {hover ? (
            <>
              <span className="tnum text-ink">{hover.date}</span>
              {" · "}
              <span className="tnum text-solar">{hover.pvKwh.toFixed(1)} kWh</span>
            </>
          ) : (
            <span className="text-ink-faint">Cada celda es un día.</span>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          menos
          {[0.12, 0.34, 0.56, 0.78, 1].map((t) => (
            <span
              key={t}
              className="inline-block h-2.5 w-2.5 rounded-sm bg-solar"
              style={{ opacity: 0.07 + t * 0.9 }}
            />
          ))}
          más
        </span>
      </div>
    </div>
  );
}
