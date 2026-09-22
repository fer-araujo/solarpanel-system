import { useMemo, useState } from "react";
import { GRID_CO2_KG_PER_KWH, summarizeDay } from "@core/energy/services/summarize-day";
import type { SystemTopology } from "@core/energy/model/power";
import { ApiError } from "@/api/client";
import {
  useBillingSummary,
  useHealth,
  useLogout,
  useMe,
  usePlantRealtime,
  useReadings,
  useSnapshot,
  useToday,
  useTopology,
} from "@/api/queries";
import { Card, Stat } from "@/ui/primitives/Card";
import { EnergyFlow } from "@/ui/charts/EnergyFlow";
import { RadialGauge } from "@/ui/charts/RadialGauge";
import { PowerGauge } from "@/ui/charts/PowerGauge";
import { StringHealth } from "@/ui/charts/StringHealth";
import { EnergyAnalysis } from "@/features/analysis/EnergyAnalysis";
import { ProductionHeatmap } from "@/features/analysis/ProductionHeatmap";
import { WeatherCard } from "@/features/weather/WeatherCard";
import { ImpactCard } from "@/features/impact/ImpactCard";
import { BillHistory } from "@/features/bolsa/BillHistory";
import { BolsaPanel } from "@/features/bolsa/BolsaPanel";
import { ReadingsForm } from "@/features/readings/ReadingsForm";
import { InverterFleet } from "@/features/inverters/InverterFleet";
import { useSunWindow } from "@/features/sun/useSunWindow";
import {
  Bone,
  FlowSkeleton,
  GaugeSkeleton,
  RowsSkeleton,
  Spinner,
  StatSkeleton,
} from "@/ui/primitives/Skeleton";

/**
 * The dashboard composes itself from the DISCOVERED topology. Nothing assumes a
 * battery or a meter, because both are genuinely optional on a residential
 * SolaX install and half the metrics die without grid metering.
 *
 * Four views: Hoy (live), Historia (the past), CFE (the bill side, which SolaX
 * cannot see) and Sistema (hardware health).
 */

/** Stat cards that stretch to their grid cell: label on top, detail at the foot. */
const FILL = "flex flex-col justify-between";

const MIN_SOC = 15;
const MAX_SOC = 97;

type Tab = "hoy" | "cfe" | "sistema";

const TABS: { id: Tab; label: string }[] = [
  { id: "hoy", label: "Hoy" },
  { id: "cfe", label: "CFE" },
  { id: "sistema", label: "Sistema" },
];

function Nav({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  return (
    <nav className="flex min-w-0 flex-1 gap-1 rounded-lg border border-line/60 bg-surface/80 p-1 sm:flex-none">
      {TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={tab === item.id ? "page" : undefined}
          onClick={() => onChange(item.id)}
          className={`flex-1 rounded-md px-2 py-1.5 text-[13px] transition-colors sm:flex-none sm:px-3.5 ${
            tab === item.id ? "bg-raised text-ink" : "text-ink-dim hover:bg-raised/50 hover:text-ink"
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

function LogoutButton() {
  const me = useMe().data;
  const logout = useLogout();
  if (!me || me.authDisabled) return null;
  return (
    <button
      type="button"
      onClick={() => logout.mutate()}
      disabled={logout.isPending}
      aria-label="Cerrar sesión"
      title="Cerrar sesión"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line/60 bg-surface/80 text-ink-faint transition-colors hover:border-alert/40 hover:text-alert disabled:opacity-60"
    >
      {logout.isPending ? (
        <Spinner />
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
          <path d="M10 17l-5-5 5-5" />
          <path d="M5 12h11" />
        </svg>
      )}
    </button>
  );
}

/**
 * Turns a failure into something actionable. A credential or configuration
 * problem needs a different response from a spent quota, so they are not
 * collapsed into one "something went wrong".
 */
function ErrorPanel({ error }: { error: Error }) {
  const api = error instanceof ApiError ? error : null;

  let hint: string | null = null;
  if (api?.isBudgetRefusal) {
    hint =
      "El servidor frenó la llamada para proteger la cuota diaria de SolaX. " +
      "Se reintenta solo; no hace falta recargar.";
  } else if (api?.solaxCode === 10401 || api?.solaxCode === 10402) {
    hint = "Revisa SOLAX_CLIENT_ID y SOLAX_CLIENT_SECRET en el .env.";
  } else if (api?.solaxCode === 10403) {
    hint = "Ese endpoint no está en el paquete de servicios API de tu cuenta del Developer Portal.";
  } else if (api?.solaxCode === 10405) {
    hint = "Se agotó la cuota diaria de llamadas. Se restablece mañana.";
  } else if (api?.status === 502) {
    hint = "SolaX respondió mal. Suele ser temporal.";
  } else if (!api) {
    hint = "¿Está corriendo el servidor? `pnpm dev:server` en otra terminal.";
  }

  return (
    <div className="rounded-2xl border border-alert/30 bg-alert/5 px-5 py-4">
      <p className="text-[13px] font-medium text-alert">No se pudieron cargar los datos</p>
      <p className="mt-1.5 text-[12.5px] text-ink-dim">{error.message}</p>
      {hint && <p className="mt-2 text-[12.5px] text-ink-faint">{hint}</p>}
    </div>
  );
}

function MeteringNotice({ topology }: { topology: SystemTopology }) {
  if (topology.hasGridMetering) return null;
  return (
    <div className="rounded-lg border border-grid/25 bg-grid/5 px-4 py-3 text-[12.5px] leading-relaxed text-ink-dim">
      <span className="text-grid">Sin medidor ni pinza CT.</span> Consumo de la casa, importado
      y exportado no se miden en vivo. La generación y los microinversores sí son reales, y la
      parte de red sale de tus lecturas en la pestaña CFE.
    </div>
  );
}

function SunIcon({ color, rays }: { color: string; rays: boolean }) {
  return (
    <svg width="12" height="12" viewBox="-8 -8 16 16" aria-hidden="true">
      <path
        d={rays ? "M -7 5 L 7 5 M 0 -6 L 0 -3 M -4.5 -2 L -2.8 -0.6 M 4.5 -2 L 2.8 -0.6" : "M -7 5 L 7 5 M 0 -6 L 0 -3"}
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M -3.4 5 A 3.4 3.4 0 0 1 3.4 5" fill={color} />
    </svg>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("hoy");

  const topologyQuery = useTopology();
  const snapshotQuery = useSnapshot();
  const todayQuery = useToday(5);
  const billingQuery = useBillingSummary();
  const health = useHealth(tab === "sistema").data;
  const readingsFile = useReadings().data;
  // Most recent dated reading, shown on the grid node of the flow diagram.
  const lastReading = useMemo(() => {
    const dated = (readingsFile?.readings ?? []).filter(
      (r): r is typeof r & { takenOn: string } => typeof r.takenOn === "string",
    );
    return dated.sort((a, b) => b.takenOn.localeCompare(a.takenOn))[0] ?? null;
  }, [readingsFile]);

  const topology = topologyQuery.data;
  const snapshot = snapshotQuery.data;
  const today = todayQuery.data;
  /**
   * The day's energy from SolaX's own counter — the figure its app and the
   * heatmap show. Integrating the 5-minute curve overestimates it by 2-4%, so
   * that is only the fallback.
   */
  const dailyYield = usePlantRealtime().data?.dailyYield ?? null;
  // After the phone resumes a frozen tab, the last numbers show until the
  // refetch lands; label them rather than pass them off as current.
  const todayRefreshing =
    todayQuery.isFetching && Date.now() - todayQuery.dataUpdatedAt > 10 * 60_000;
  // House consumption per day, exact over the periods closed by the readings.
  const dailyLoadKwh = billingQuery.data?.balance?.averageDailyLoadKwh ?? null;
  const sun = useSunWindow(topology);

  /**
   * One line describing the inverter fleet. With a microinverter array a
   * single status would hide a unit that is down — the count of healthy units
   * and the hottest temperature are what matter.
   */
  const fleetSummary = useMemo(() => {
    const units = snapshot?.inverters ?? [];
    if (units.length === 0) return "";
    const temps = units.map((u) => u.temperatureC).filter((t): t is number => t !== null);
    const hottest = temps.length > 0 ? Math.max(...temps) : null;
    if (units.length === 1) {
      return ` · ${units[0]?.status ?? ""}${hottest === null ? "" : ` · ${hottest} °C`}`;
    }
    const normal = units.filter((u) => u.status === "Normal").length;
    const healthLine =
      normal === units.length ? `${units.length} inversores OK` : `${normal}/${units.length} inversores OK`;
    return ` · ${healthLine}${hottest === null ? "" : ` · máx ${hottest} °C`}`;
  }, [snapshot?.inverters]);

  const summary = useMemo(() => {
    if (!today) return null;
    return summarizeDay(today.samples, {
      stepMinutes: today.interval,
      pvCapacityKwp: topology?.pvCapacityKwp ?? null,
    });
  }, [today, topology?.pvCapacityKwp]);

  if (topologyQuery.isError) {
    return (
      <div className="min-h-screen bg-void p-6">
        <div className="mx-auto max-w-[900px] pt-10">
          <ErrorPanel error={topologyQuery.error} />
        </div>
      </div>
    );
  }

  const generatedKwh = dailyYield ?? summary?.pvKwh ?? 0;
  const capacityKwp = topology?.pvCapacityKwp ?? null;
  const specificYield = capacityKwp ? generatedKwh / capacityKwp : null;

  const gaugeCaption = sun
    ? sun.isDaylight
      ? `sol arriba · anochece ${sun.sunset}`
      : `de noche · amanece ${sun.sunrise}`
    : undefined;

  return (
    // Clipped here, not only on html/body: Chrome for Android still lets a
    // finger pan the viewport sideways when just the root elements clip.
    <div className="min-h-screen overflow-x-clip bg-void">
      <header className="sticky top-0 z-10 border-b border-line/50 bg-void/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-solar/25 bg-solar/10">
              <span className="h-2.5 w-2.5 rounded-full bg-solar" />
            </div>
            <div>
              {topology ? (
                <h1 className="text-[15px] font-medium text-ink">{topology.plantName}</h1>
              ) : (
                <Bone className="h-4 w-40" />
              )}
              <p className="tnum mt-0.5 text-[12px] text-ink-faint">
                {topology?.pvCapacityKwp ? `${topology.pvCapacityKwp} kWp` : "— kWp"}
                {topology?.batteryCapacityKwh ? ` · ${topology.batteryCapacityKwh} kWh` : ""}
                {fleetSummary}
              </p>
            </div>
          </div>

          <div className="flex w-full items-center gap-2 sm:w-auto sm:gap-4">
            {sun && (
              <span className="hidden items-center gap-3 text-[12px] text-ink-faint md:flex">
                <span className="flex items-center gap-1.5">
                  <SunIcon color="var(--color-grid)" rays />
                  <span className="tnum">{sun.sunrise}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <SunIcon color="var(--color-ink-faint)" rays={false} />
                  <span className="tnum">{sun.sunset}</span>
                </span>
              </span>
            )}
            {snapshot && (
              <span
                className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1 text-[12px] ${
                  snapshot.stale ? "border-grid/25 bg-grid/8 text-grid" : "border-solar/25 bg-solar/8 text-solar"
                }`}
              >
                <span className="relative flex h-1.5 w-1.5">
                  {!snapshot.stale && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-solar opacity-70" />
                  )}
                  <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${snapshot.stale ? "bg-grid" : "bg-solar"}`} />
                </span>
                <span className="hidden sm:inline">{snapshot.stale ? "Datos en caché" : "En línea"}</span>
                <span className="tnum">
                  {snapshot.power.at.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}
                </span>
              </span>
            )}
            <Nav tab={tab} onChange={setTab} />
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] space-y-5 px-4 py-5 sm:px-6 sm:py-6">
        {snapshotQuery.isError && <ErrorPanel error={snapshotQuery.error} />}

        {tab === "hoy" && (
          <>
            {topology && <MeteringNotice topology={topology} />}

            <div className="grid gap-5 lg:grid-cols-[330px_minmax(0,1fr)]">
              {/* Flex column stretched to the row: the stat grid takes whatever
                  height the flow diagram leaves, so there is no dead space. */}
              <div className="flex flex-col gap-5">
                <Card title="Potencia solar">
                  {snapshot ? (
                    <PowerGauge
                      watts={snapshot.power.pv}
                      capacityKwp={topology?.pvCapacityKwp ?? null}
                      {...(gaugeCaption ? { caption: gaugeCaption } : {})}
                    />
                  ) : (
                    <GaugeSkeleton />
                  )}
                </Card>

                {/* The informative cards fill the column under the gauge. */}
                {!summary && todayQuery.isPending && (
                  <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-3">
                    {Array.from({ length: 4 }, (_, i) => (
                      <StatSkeleton key={i} />
                    ))}
                  </div>
                )}
                {summary && (
                  <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-3">
                    <Stat className={FILL} label="Generado hoy" value={generatedKwh.toFixed(1)} unit="kWh" tone="solar"
                      detail={todayRefreshing ? "actualizando…" : `pico ${summary.peakPvKw} kW`} />
                    <Stat className={FILL} label="Rendimiento"
                      value={specificYield === null ? "—" : specificYield.toFixed(2)}
                      unit={specificYield === null ? undefined : "kWh/kWp"}
                      detail="horas sol equiv." tone="batt" />
                    <Stat className={FILL} label="CO₂ evitado" value={(generatedKwh * GRID_CO2_KG_PER_KWH).toFixed(1)} unit="kg" tone="solar"
                      detail="hoy" />
                    {summary.loadKwh !== null ? (
                      <Stat className={FILL} label="Autosuficiencia"
                        value={summary.selfSufficiency === null ? "—" : summary.selfSufficiency.toFixed(0)}
                        unit="%" detail={`${summary.loadKwh.toFixed(1)} kWh consumidos`} tone="solar" />
                    ) : (
                      <Stat className={FILL} label="Consumo diario"
                        value={dailyLoadKwh === null ? "—" : `~${dailyLoadKwh.toFixed(0)}`}
                        unit={dailyLoadKwh === null ? undefined : "kWh"}
                        detail={dailyLoadKwh === null ? "captura lecturas en CFE" : "promedio de tus lecturas"} />
                    )}
                  </div>
                )}

                {topology?.hasBattery && snapshot?.battery && (
                  <Card title="Batería">
                    <RadialGauge
                      soc={snapshot.battery.soc}
                      capacityKwh={snapshot.battery.capacityKwh}
                      minSoc={MIN_SOC}
                      maxSoc={MAX_SOC}
                      flowWatts={snapshot.battery.power}
                    />
                  </Card>
                )}
              </div>

              <Card title="Flujo en tiempo real" hint="Las líneas corren más rápido donde pasan más watts">
                {snapshot ? (
                  <EnergyFlow
                    snapshot={snapshot.power}
                    hasBattery={topology?.hasBattery ?? false}
                    hasGridMetering={topology?.hasGridMetering ?? false}
                    lastReading={lastReading}
                    estimatedLoadWatts={dailyLoadKwh === null ? null : (dailyLoadKwh * 1000) / 24}
                    {...(sun ? { isDaylight: sun.isDaylight, sunrise: sun.sunrise } : {})}
                  />
                ) : (
                  <FlowSkeleton />
                )}
              </Card>
            </div>

            {/* One chart with Día / Mes / Año / Todo — no separate history tab. */}
            <EnergyAnalysis installedAt={topology?.installedAt ?? null} />

            <ProductionHeatmap installedAt={topology?.installedAt ?? null} />

            <div className="grid gap-5 lg:grid-cols-2">
              <WeatherCard
                latitude={topology?.latitude ?? null}
                longitude={topology?.longitude ?? null}
                pvCapacityKwp={topology?.pvCapacityKwp ?? null}
                sun={sun}
              />
              <ImpactCard />
            </div>
          </>
        )}

        {tab === "cfe" && (
          <>
            {/* Input → result → history. */}
            <ReadingsForm />
            <BolsaPanel query={billingQuery} />
            <BillHistory />
          </>
        )}

        {tab === "sistema" && (
          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              title={snapshot && snapshot.inverters.length > 1 ? `Microinversores · ${snapshot.inverters.length}` : "Inversor"}
              hint="Cada unidad con sus propios paneles"
            >
              {snapshot ? (
                <InverterFleet inverters={snapshot.inverters} strings={snapshot.strings} />
              ) : (
                <RowsSkeleton rows={3} />
              )}
            </Card>

            <div className="space-y-5">
              <Card title="Alarmas activas">
                {!snapshot ? (
                  <RowsSkeleton rows={1} />
                ) : snapshot.alarms.length > 0 ? (
                  <ul className="space-y-2.5">
                    {snapshot.alarms.map((alarm, i) => (
                      <li key={`${alarm.errorCode}-${i}`} className="rounded-lg border border-alert/25 bg-alert/5 px-3.5 py-2.5 text-[12.5px]">
                        <p className="text-alert">{alarm.alarmName ?? alarm.errorCode}</p>
                        <p className="tnum mt-1 text-ink-faint">
                          {alarm.deviceSn} · desde {alarm.alarmStartTime}
                        </p>
                        {alarm.handleSuggestion && alarm.handleSuggestion !== "/" && (
                          <p className="mt-1 text-ink-dim">{alarm.handleSuggestion}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-4 text-center text-[13px] text-ink-faint">Sin alarmas. Todo en orden.</p>
                )}
              </Card>

              <Card title="Conexión con SolaX">
                {health ? (
                  <dl className="tnum grid grid-cols-2 gap-y-2 text-[12.5px]">
                    <dt className="text-ink-faint">Token</dt>
                    <dd className="text-right text-ink">
                      {health.token.hasToken && health.token.expiresInMs !== null
                        ? `vence en ${Math.round(health.token.expiresInMs / 86_400_000)} días`
                        : "sin token aún"}
                    </dd>
                    <dt className="text-ink-faint">Llamadas hoy</dt>
                    <dd className="text-right text-ink">
                      {health.budget.perDayUsed} / {health.budget.perDayLimit.toLocaleString("es-MX")}
                    </dd>
                    <dt className="text-ink-faint">Último minuto</dt>
                    <dd className="text-right text-ink">
                      {health.budget.perMinuteUsed} / {health.budget.perMinuteLimit}
                    </dd>
                  </dl>
                ) : (
                  <RowsSkeleton rows={3} />
                )}
              </Card>
            </div>

            {snapshot && snapshot.strings.length > 0 && (
              <Card title="Paneles" hint="Cada panel comparado contra el promedio del arreglo">
                <StringHealth strings={snapshot.strings} />
              </Card>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
