import type {
  BatteryState,
  InverterState,
  PowerSnapshot,
  PvStringReading,
  SystemTopology,
} from "@core/energy/model/power";
import type { AlarmDto } from "@core/solax/dto/device";
import type { BankPeriod, BankProjection } from "@core/billing/services/energy-bank";
import type { DacRisk } from "@core/billing/services/dac-risk";
import type { BalanceTrend } from "@core/billing/services/period-balance";
import type { MeterReading } from "@core/billing/model/meter-reading";
import { accessToken, getSupabase } from "./auth";

/**
 * Typed client for our own BFF.
 *
 * The response types are the DOMAIN types, imported straight from `core/`.
 * They are pure TypeScript with no runtime, so the browser and the server share
 * one definition instead of two that drift. Nothing SolaX-shaped appears here —
 * the server already normalised units and signs.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly solaxCode: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    status: number;
    message: string;
    solaxCode?: number;
    retryable?: boolean;
    retryAfterMs?: number;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.solaxCode = options.solaxCode;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** The server refused locally to protect the daily SolaX quota. */
  get isBudgetRefusal(): boolean {
    return this.status === 429;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    // The server sends a structured error; fall back to the status if it did not.
    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    throw new ApiError({
      status: response.status,
      message:
        typeof payload.error === "string"
          ? payload.error
          : `Request to ${path} failed with ${response.status}`,
      ...(typeof payload.solaxCode === "number" ? { solaxCode: payload.solaxCode } : {}),
      ...(typeof payload.retryable === "boolean" ? { retryable: payload.retryable } : {}),
      ...(typeof payload.retryAfterMs === "number"
        ? { retryAfterMs: payload.retryAfterMs }
        : {}),
    });
  }

  return (await response.json()) as T;
}

/**
 * `at` arrives as an ISO string over JSON. Revived here so components can rely
 * on a Date, rather than each one remembering to parse.
 */
function reviveSnapshot(raw: PowerSnapshot & { at: string | Date }): PowerSnapshot {
  return { ...raw, at: raw.at instanceof Date ? raw.at : new Date(raw.at) };
}

export interface HealthResponse {
  ok: boolean;
  baseUrl: string;
  businessType: number;
  token: { hasToken: boolean; expiresInMs: number | null };
  budget: {
    perMinuteUsed: number;
    perMinuteLimit: number;
    perDayUsed: number;
    perDayLimit: number;
    backoffMsRemaining: number;
  };
  cacheEntries: number;
}

export interface SnapshotResponse {
  power: PowerSnapshot;
  strings: PvStringReading[];
  /**
   * One entry per physical unit. A microinverter array has several, so this is
   * a list rather than a single inverter.
   */
  inverters: InverterState[];
  battery: BatteryState | null;
  alarms: AlarmDto[];
  stale: boolean;
  at: number;
}

export interface TodayResponse {
  samples: PowerSnapshot[];
  interval: number;
  /** False when the plant's UTC offset could not be parsed, so "today" is the server's day. */
  dayBoundsExact: boolean;
  stale: boolean;
}

export interface PlantStatEntry {
  date: string;
  pvGeneration: number | null;
  inverterACOutputEnergy: number | null;
  exportEnergy: number | null;
  importEnergy: number | null;
  loadConsumption: number | null;
  batteryCharged: number | null;
  batteryDischarged: number | null;
  earnings: number | null;
}

export interface StatsResponse {
  plantId: string | null;
  date: string | null;
  currencyCode: string | null;
  plantEnergyStatDataList: PlantStatEntry[] | null;
  stale: boolean;
}

export interface BillingSummaryResponse {
  periods: BankPeriod[];
  projection: BankProjection | null;
  dac: DacRisk | null;
  savings: { period: string; amount: number }[] | null;
  /**
   * The energy balance closed per period: PV from the inverters plus grid flow
   * from the bill yields the house load exactly, and with it self-sufficiency
   * and self-consumption on a plant that has no meter.
   */
  balance: BalanceTrend | null;
  /** Typical gross consumption per bimester, from the last year of bills. */
  averageBimonthlyKwh?: number | null;
  currency?: string;
  tariff: { code: string; verified: boolean; note?: string };
}

export interface ReadingsResponse {
  version: 1;
  carryoverKwh: number;
  meterInstalledOn?: string;
  readings: MeterReading[];
  history: { period: string; kwh: number; amountMxn?: number }[];
}

export interface PlantRealtimeResponse {
  plantLocalTime: string | null;
  dailyYield: number | null;
  totalYield: number | null;
  stale: boolean;
}

export interface MeResponse {
  user: string;
  /** True locally when Supabase is not configured and auth is off. */
  authDisabled?: boolean;
}

const unauthorized = (message: string) => new ApiError({ status: 401, message });

export const api = {
  auth: {
    /** Asks Supabase (not the local cache) so a revoked user is sent back to login. */
    me: async (): Promise<MeResponse> => {
      const supabase = await getSupabase();
      if (!supabase) return { user: "local", authDisabled: true };
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) throw unauthorized("Sesión requerida");
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) throw unauthorized("Sesión expirada");
      return { user: data.user.email ?? data.user.id };
    },
    login: async (email: string, password: string): Promise<MeResponse> => {
      const supabase = await getSupabase();
      if (!supabase) return { user: "local", authDisabled: true };
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error || !data.user) {
        if (error?.status === 429) {
          throw new ApiError({ status: 429, message: "Demasiados intentos. Espera unos minutos." });
        }
        throw unauthorized("Correo o contraseña incorrectos.");
      }
      return { user: data.user.email ?? data.user.id };
    },
    logout: async (): Promise<void> => {
      const supabase = await getSupabase();
      await supabase?.auth.signOut();
    },
  },

  health: () => request<HealthResponse>("/api/health"),

  topology: () => request<SystemTopology>("/api/topology"),

  snapshot: async (): Promise<SnapshotResponse> => {
    const raw = await request<SnapshotResponse & { power: PowerSnapshot & { at: string } }>(
      "/api/snapshot",
    );
    return { ...raw, power: reviveSnapshot(raw.power) };
  },

  today: async (interval = 5): Promise<TodayResponse> => {
    const raw = await request<
      TodayResponse & { samples: (PowerSnapshot & { at: string })[] }
    >(`/api/history/today?interval=${interval}`);
    return { ...raw, samples: raw.samples.map(reviveSnapshot) };
  },

  day: async (date: string, interval = 5): Promise<TodayResponse> => {
    const raw = await request<
      TodayResponse & { samples: (PowerSnapshot & { at: string })[] }
    >(`/api/history/day?date=${date}&interval=${interval}`);
    return { ...raw, samples: raw.samples.map(reviveSnapshot) };
  },

  plantRealtime: () => request<PlantRealtimeResponse>("/api/plant/realtime"),

  statsYear: (year: number) => request<StatsResponse>(`/api/stats/year/${year}`),

  statsMonth: (month: string) => request<StatsResponse>(`/api/stats/month/${month}`),

  alarms: (state: "ongoing" | "closed" = "ongoing") =>
    request<{ alarms: AlarmDto[]; stale: boolean }>(`/api/alarms?state=${state}`),

  billingSummary: (dacBasis: "gross" | "billed" = "billed") =>
    request<BillingSummaryResponse>(`/api/billing/summary?dacBasis=${dacBasis}`),

  readings: () => request<ReadingsResponse>("/api/billing/readings"),

  saveReading: (reading: MeterReading) =>
    request<ReadingsResponse>("/api/billing/readings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reading),
    }),

  deleteReading: (period: string) =>
    request<ReadingsResponse>(`/api/billing/readings/${period}`, { method: "DELETE" }),

  saveMeter: (patch: { carryoverKwh?: number; meterInstalledOn?: string }) =>
    request<ReadingsResponse>("/api/billing/meter", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
};
