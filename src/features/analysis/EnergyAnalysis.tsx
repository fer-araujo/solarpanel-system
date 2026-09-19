import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { api, type PlantStatEntry } from "@/api/client";
import { queryKeys, useBillingSummary, useDay, useStatsMonth, useStatsYear } from "@/api/queries";
import { Card } from "@/ui/primitives/Card";
import { ProductionCurve } from "@/ui/charts/ProductionCurve";
import { MonthlyEnergy } from "@/ui/charts/MonthlyEnergy";
import { ChartSkeleton } from "@/ui/primitives/Skeleton";

/**
 * Day / Month / Year / All with date navigation.
 *
 * Call cost per view, which is why each is fetched lazily:
 * - Day: 2 history calls, and past days are cached forever (they cannot change)
 * - Month: 1 stats call  ·  Year: 1  ·  All: 1 per year since installation
 */

type Mode = "day" | "month" | "year" | "all";

const MODES: { id: Mode; label: string }[] = [
  { id: "day", label: "Día" },
  { id: "month", label: "Mes" },
  { id: "year", label: "Año" },
  { id: "all", label: "Todo" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function shift(date: Date, mode: Mode, step: number): Date {
  const next = new Date(date);
  if (mode === "day") next.setDate(next.getDate() + step);
  if (mode === "month") next.setMonth(next.getMonth() + step, 1);
  if (mode === "year") next.setFullYear(next.getFullYear() + step, 0, 1);
  return next;
}

function total(entries: PlantStatEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.pvGeneration ?? 0), 0);
}

export function EnergyAnalysis({ installedAt }: { installedAt: string | null }) {
  const [mode, setMode] = useState<Mode>("day");
  const [cursor, setCursor] = useState(() => new Date());
  // Average house load from the meter-reading balance, in watts.
  const dailyLoadKwh = useBillingSummary().data?.balance?.averageDailyLoadKwh ?? null;
  const averageLoadWatts = dailyLoadKwh === null ? null : (dailyLoadKwh * 1000) / 24;

  const now = new Date();
  const dayKey = iso(cursor);
  const monthKey = dayKey.slice(0, 7);
  const year = cursor.getFullYear();
  const isToday = dayKey === iso(now);
  const firstYear = installedAt ? Number(installedAt.slice(0, 4)) : now.getFullYear();

  const dayQuery = useDay(dayKey, isToday);
  const monthQuery = useStatsMonth(monthKey, mode === "month");
  const yearQuery = useStatsYear(year);

  const years = useMemo(() => {
    const list: number[] = [];
    for (let y = firstYear; y <= now.getFullYear(); y++) list.push(y);
    return list;
  }, [firstYear, now.getFullYear()]);

  const allQueries = useQueries({
    queries: years.map((y) => ({
      queryKey: queryKeys.statsYear(y),
      queryFn: () => api.statsYear(y),
      staleTime: 60 * 60 * 1000,
      enabled: mode === "all",
    })),
  });

  const allEntries: PlantStatEntry[] = years.map((y, i) => {
    const list = allQueries[i]?.data?.plantEnergyStatDataList ?? [];
    return {
      date: String(y),
      pvGeneration: total(list),
      inverterACOutputEnergy: null,
      exportEnergy: null,
      importEnergy: null,
      loadConsumption: null,
      batteryCharged: null,
      batteryDischarged: null,
      earnings: null,
    };
  });

  // Never navigate into the future, nor before the plant existed.
  const canNext = mode !== "all" && shift(cursor, mode, 1) <= now;
  const canPrev = mode !== "all" && shift(cursor, mode, -1).getFullYear() >= firstYear;

  const title =
    mode === "day"
      ? cursor.toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
      : mode === "month"
        ? cursor.toLocaleDateString("es-MX", { month: "long", year: "numeric" })
        : mode === "year"
          ? String(year)
          : `${firstYear} – ${now.getFullYear()}`;

  const failed =
    mode === "day"
      ? dayQuery.error
      : mode === "month"
        ? monthQuery.error
        : mode === "year"
          ? yearQuery.error
          : (allQueries.find((q) => q.error)?.error ?? null);

  let body: React.ReactNode;
  if (failed) {
    body = (
      <p className="py-10 text-center text-[13px] text-alert">
        No se pudo cargar: {failed.message}
      </p>
    );
  } else if (mode === "day") {
    body = dayQuery.data ? (
      <ProductionCurve samples={dayQuery.data.samples} averageLoadWatts={averageLoadWatts} />
    ) : (
      <ChartSkeleton />
    );
  } else if (
    (mode === "month" && monthQuery.isPending) ||
    (mode === "year" && yearQuery.isPending) ||
    (mode === "all" && allQueries.some((q) => q.isPending))
  ) {
    body = <ChartSkeleton />;
  } else {
    const entries =
      mode === "month"
        ? (monthQuery.data?.plantEnergyStatDataList ?? [])
        : mode === "year"
          ? (yearQuery.data?.plantEnergyStatDataList ?? [])
          : allEntries;
    const label =
      mode === "month" ? (d: string) => String(Number(d.slice(8, 10))) : mode === "all" ? (d: string) => d : undefined;
    body = <MonthlyEnergy entries={entries} {...(label ? { label } : {})} />;
  }

  return (
    <Card
      title="Análisis de energía"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg border border-line/60 bg-surface p-1">
            {MODES.map((m) => (
              <button key={m.id} type="button" onClick={() => setMode(m.id)}
                className={`rounded-md px-3 py-1 text-[12.5px] ${mode === m.id ? "bg-raised text-ink" : "text-ink-dim hover:text-ink"}`}>
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Anterior" disabled={!canPrev}
              onClick={() => setCursor((c) => shift(c, mode, -1))}
              className="rounded-md px-2 py-1 text-ink-dim hover:text-ink disabled:opacity-30">‹</button>
            <span className="tnum min-w-[150px] text-center text-[12.5px] text-ink">{title}</span>
            <button type="button" aria-label="Siguiente" disabled={!canNext}
              onClick={() => setCursor((c) => shift(c, mode, 1))}
              className="rounded-md px-2 py-1 text-ink-dim hover:text-ink disabled:opacity-30">›</button>
          </div>
        </div>
      }
    >
      {body}
    </Card>
  );
}
