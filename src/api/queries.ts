import { useCallback, useSyncExternalStore } from "react";
import {
  QueryCache,
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { MeterReading, PeriodBill } from "@core/billing/model/meter-reading";
import { signOut } from "./auth";
import { clearPersistedCache, PERSIST_MAX_AGE_MS } from "./persist";
import {
  ApiError,
  api,
  type ReadingsResponse,
  type SnapshotResponse,
} from "./client";

/**
 * Query wiring, with polling tuned to the hardware rather than to taste.
 *
 * The dongle uploads about every five minutes, so the snapshot is polled at 60s
 * to feel live and then BACKS OFF to five minutes once the reported timestamp
 * stops advancing. Polling faster than the dongle spends the daily quota for
 * data that has not changed — and the quota is a hard wall (code 10405) that
 * locks the account out for the rest of the day.
 */

const FAST_POLL_MS = 60_000;
const SLOW_POLL_MS = 5 * 60_000;
/** Consecutive identical timestamps before we accept the dongle is idle. */
const STALL_THRESHOLD = 2;

/**
 * Upper bound on waiting out a 429 before the single retry. The server's
 * 10406 penalty is 65 s; anything longer is a daily-quota answer, not a pause.
 */
const MAX_RETRY_AFTER_MS = 70_000;

/**
 * Spread added to that wait. Every panel of a page load is refused at once;
 * retrying them all at the same instant would spend the reopened window in
 * one burst and trip the limit again.
 */
const RETRY_JITTER_MS = 20_000;

/** Worth one retry: a per-minute refusal that says when the window reopens. */
function isTransientRefusal(error: unknown): error is ApiError & { retryAfterMs: number } {
  return (
    error instanceof ApiError &&
    error.isBudgetRefusal &&
    error.retryAfterMs !== undefined &&
    error.scope !== "day"
  );
}


export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    // Any 401 means the session expired mid-use: re-check it, which sends the
    // gate back to the login screen instead of leaving broken panels. Either
    // way the cached panels go too, from memory and from disk.
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!(error instanceof ApiError) || query.queryKey[0] === "auth") return;
        if (error.status === 401) {
          forgetSession(client);
        } else if (error.status === 403) {
          // Signed in, but not on the allow list: drop the session.
          void signOut().finally(() => forgetSession(client));
        }
      },
    }),
    defaultOptions: {
      queries: {
        // refetchInterval already pauses while the tab is in the background,
        // which is exactly what a quota-limited API wants.
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          // A per-minute refusal is retried exactly ONCE, after the pause the
          // server asked for. Without it a panel stayed broken until its next
          // poll (minutes), while retrying sooner would only re-trip the limit.
          // A daily-quota refusal has nothing worth waiting out.
          if (error instanceof ApiError && error.isBudgetRefusal) {
            return failureCount < 1 && isTransientRefusal(error);
          }
          if (error instanceof ApiError && !error.retryable && error.status < 500) {
            return false;
          }
          return failureCount < 2;
        },
        retryDelay: (failureCount, error) => {
          if (isTransientRefusal(error)) {
            return (
              Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS) + Math.random() * RETRY_JITTER_MS
            );
          }
          return Math.min(1_000 * 2 ** failureCount, 30_000);
        },
        staleTime: 30_000,
        // Must outlive the persisted copy, or restored queries are collected
        // before anything observes them.
        gcTime: PERSIST_MAX_AGE_MS,
      },
    },
  });
  return client;
}

export const authKey = ["auth", "me"] as const;

/**
 * Drops every cached panel, in memory and on disk, then re-checks the session
 * so the gate shows the login. Used whenever a session ends or is refused.
 */
export function forgetSession(client: QueryClient): void {
  clearPersistedCache();
  // Everything except the session query itself, which stays observed by the
  // gate: removing it would leave the gate holding the old answer, while
  // invalidating it refetches and lands on the login screen.
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== authKey[0] });
  client.getMutationCache().clear();
  void client.invalidateQueries({ queryKey: authKey });
}

/** A response the server answered from its cache because SolaX refused or failed. */
function isServedStale(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { stale?: unknown }).stale === true;
}

/**
 * True while any panel on screen shows data the server flagged `stale`. Only
 * observed queries count, so a cached response for a view that is not open
 * does not keep the badge lit.
 */
export function useServedStale(): boolean {
  const client = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => client.getQueryCache().subscribe(onChange),
    [client],
  );
  const read = useCallback(
    () =>
      client
        .getQueryCache()
        .getAll()
        .some((query) => query.getObserversCount() > 0 && isServedStale(query.state.data)),
    [client],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Who is logged in. A 401 here is the signal to show the login screen. */
export function useMe() {
  return useQuery({
    queryKey: authKey,
    queryFn: api.auth.me,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      api.auth.login(email, password),
    onSuccess: (me) => client.setQueryData(authKey, me),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.auth.logout,
    // Drop every cached panel so nothing from the session lingers in memory
    // or on disk.
    onSettled: () => forgetSession(client),
  });
}

export const queryKeys = {
  health: ["health"] as const,
  topology: ["topology"] as const,
  snapshot: ["snapshot"] as const,
  today: (interval: number) => ["today", interval] as const,
  statsYear: (year: number) => ["stats", "year", year] as const,
  statsMonth: (month: string) => ["stats", "month", month] as const,
  billing: (basis: string) => ["billing", basis] as const,
  readings: ["readings"] as const,
};

export function useTopology() {
  return useQuery({
    queryKey: queryKeys.topology,
    queryFn: api.topology,
    // What hardware is fitted changes when someone installs something, not
    // minute to minute.
    staleTime: 6 * 60 * 60 * 1000,
  });
}

/** Tracks how many polls in a row reported the same instant. */
let stalledPolls = 0;
let lastSeenAt: number | null = null;

export function useSnapshot(): UseQueryResult<SnapshotResponse, Error> {
  return useQuery({
    queryKey: queryKeys.snapshot,
    queryFn: async () => {
      const snapshot = await api.snapshot();
      const at = snapshot.power.at.getTime();
      if (lastSeenAt !== null && at === lastSeenAt) stalledPolls += 1;
      else stalledPolls = 0;
      lastSeenAt = at;
      return snapshot;
    },
    refetchInterval: () =>
      stalledPolls >= STALL_THRESHOLD ? SLOW_POLL_MS : FAST_POLL_MS,
    staleTime: FAST_POLL_MS / 2,
  });
}

export function useToday(interval = 5) {
  return useQuery({
    queryKey: queryKeys.today(interval),
    queryFn: () => api.today(interval),
    // The curve only gains a point every `interval` minutes.
    refetchInterval: interval * 60_000,
    staleTime: (interval * 60_000) / 2,
  });
}

export function useStatsYear(year: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.statsYear(year),
    queryFn: () => api.statsYear(year),
    staleTime: 60 * 60 * 1000,
    enabled,
  });
}

/**
 * Billing data is driven by manual input, so there is nothing to poll for.
 * Not cached forever, though: the cache is persisted, and a reading saved on
 * another device must still show up on the next reload.
 */
const MANUAL_DATA_STALE_MS = 5 * 60_000;

export function useBillingSummary(basis: "gross" | "billed" = "billed") {
  return useQuery({
    queryKey: queryKeys.billing(basis),
    queryFn: () => api.billingSummary(basis),
    staleTime: MANUAL_DATA_STALE_MS,
  });
}

export function useReadings() {
  return useQuery({
    queryKey: queryKeys.readings,
    queryFn: api.readings,
    staleTime: MANUAL_DATA_STALE_MS,
  });
}

/**
 * Saving a reading changes the bolsa, the projection and the DAC assessment, so
 * both caches are invalidated together. Forgetting the billing key would leave
 * the table updated and the headline number stale.
 */
function useReadingsMutation<TArgs>(
  run: (args: TArgs) => Promise<ReadingsResponse>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (file) => {
      client.setQueryData(queryKeys.readings, file);
      void client.invalidateQueries({ queryKey: ["billing"] });
    },
  });
}

export function useSaveReading() {
  return useReadingsMutation<MeterReading>(api.saveReading);
}

export function useDeleteReading() {
  return useReadingsMutation<string>(api.deleteReading);
}

export function useClosePeriod() {
  return useReadingsMutation<{ end: string; bill: PeriodBill }>(api.closePeriod);
}

export function useSaveMeter() {
  return useReadingsMutation<{ carryoverKwh?: number; meterInstalledOn?: string }>(
    api.saveMeter,
  );
}

/**
 * Any day's curve. A past day cannot change, but a copy fetched while it was
 * still "today" is partial, so past days go stale after an hour rather than
 * never (the server keeps closed windows cached, so a refetch is cheap).
 */
export function useDay(date: string, isToday: boolean, enabled = true) {
  return useQuery({
    queryKey: ["day", date],
    queryFn: () => api.day(date, 5),
    refetchInterval: isToday ? 5 * 60_000 : false,
    staleTime: isToday ? 150_000 : 60 * 60 * 1000,
    enabled,
  });
}

/** The current month still gains today's production, so it goes stale sooner. */
export const statsStaleTime = (month: string) =>
  new Date().toISOString().startsWith(month) ? 10 * 60 * 1000 : 60 * 60 * 1000;

export function useStatsMonth(month: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.statsMonth(month),
    queryFn: () => api.statsMonth(month),
    staleTime: statsStaleTime(month),
    enabled,
  });
}

export function usePlantRealtime() {
  return useQuery({
    queryKey: ["plant", "realtime"],
    queryFn: api.plantRealtime,
    refetchInterval: 5 * 60_000,
  });
}

export interface Weather {
  currentTempC: number | null;
  currentCode: number | null;
  daily: {
    date: string;
    maxC: number;
    minC: number;
    code: number;
    /** MJ/m² over the day — what the panels will actually see. */
    radiationMj: number;
  }[];
}

/**
 * Forecast from Open-Meteo: free, no key, CORS-enabled, so it is called from
 * the browser and costs no SolaX quota. Shortwave radiation is the useful bit —
 * it turns the forecast into an expected-production figure.
 */
export function useWeather(latitude: number | null, longitude: number | null) {
  return useQuery({
    queryKey: ["weather", latitude, longitude],
    enabled: latitude !== null && longitude !== null,
    staleTime: 30 * 60_000,
    refetchInterval: 30 * 60_000,
    queryFn: async (): Promise<Weather> => {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        `&current=temperature_2m,weather_code` +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code,shortwave_radiation_sum` +
        `&timezone=auto&forecast_days=3`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
      const json = (await response.json()) as {
        current?: { temperature_2m?: number; weather_code?: number };
        daily: {
          time: string[];
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          weather_code: number[];
          shortwave_radiation_sum: number[];
        };
      };
      return {
        currentTempC: json.current?.temperature_2m ?? null,
        currentCode: json.current?.weather_code ?? null,
        daily: json.daily.time.map((date, i) => ({
          date,
          maxC: json.daily.temperature_2m_max[i] ?? 0,
          minC: json.daily.temperature_2m_min[i] ?? 0,
          code: json.daily.weather_code[i] ?? 0,
          radiationMj: json.daily.shortwave_radiation_sum[i] ?? 0,
        })),
      };
    },
  });
}

/**
 * SolaX connection status. Only polled while the Sistema tab is open — it was
 * nearly 40% of all function invocations for a panel nobody is looking at.
 */
export function useHealth(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: api.health,
    refetchInterval: enabled ? FAST_POLL_MS : false,
    enabled,
  });
}
