import { useWeather } from "@/api/queries";
import { Card } from "@/ui/primitives/Card";
import type { SunWindow } from "@/features/sun/useSunWindow";

/**
 * Weather, daylight and EXPECTED production.
 *
 * The forecast's shortwave radiation (MJ/m²) converts to kWh/m² by ÷3.6 — the
 * "peak sun hours" a panel will see. Multiplied by installed kWp and a
 * performance ratio, it forecasts tomorrow's generation. The vendor app shows
 * the weather; this turns it into a number that matters.
 */

/** Typical system losses: inverter, temperature, soiling, wiring. */
const PERFORMANCE_RATIO = 0.8;

function describe(code: number): string {
  if (code === 0) return "Despejado";
  if (code <= 3) return "Parcialmente nublado";
  if (code <= 48) return "Niebla";
  if (code <= 67) return "Lluvia";
  if (code <= 77) return "Nieve";
  if (code <= 82) return "Chubascos";
  return "Tormenta";
}

export function WeatherCard({
  latitude,
  longitude,
  pvCapacityKwp,
  sun,
}: {
  latitude: number | null;
  longitude: number | null;
  pvCapacityKwp: number | null;
  sun: SunWindow | null;
}) {
  const { data, isError } = useWeather(latitude, longitude);

  if (isError) {
    return (
      <Card title="Clima">
        <p className="text-[12.5px] text-ink-faint">No se pudo obtener el pronóstico.</p>
      </Card>
    );
  }

  const today = data?.daily[0];

  return (
    <Card title="Clima y producción esperada">
      {!data ? (
        <p className="animate-pulse py-6 text-center text-[13px] text-ink-faint">Cargando…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="tnum text-[34px] leading-none font-medium text-ink">
                {data.currentTempC === null ? "—" : `${Math.round(data.currentTempC)}°`}
              </p>
              <p className="mt-1.5 text-[12.5px] text-ink-dim">
                {data.currentCode === null ? "" : describe(data.currentCode)}
                {today ? ` · ${Math.round(today.minC)}° – ${Math.round(today.maxC)}°` : ""}
              </p>
            </div>
            {sun && (
              <div className="tnum text-right text-[12px] text-ink-faint">
                <p>amanece {sun.sunrise}</p>
                <p>anochece {sun.sunset}</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 border-t border-line/50 pt-3">
            {data.daily.map((day, i) => {
              const sunHours = day.radiationMj / 3.6;
              const expected =
                pvCapacityKwp === null ? null : sunHours * pvCapacityKwp * PERFORMANCE_RATIO;
              return (
                <div key={day.date} className="rounded-lg bg-raised/50 px-2.5 py-2">
                  <p className="text-[11px] text-ink-faint uppercase">
                    {i === 0
                      ? "Hoy"
                      : new Date(`${day.date}T12:00:00`).toLocaleDateString("es-MX", { weekday: "short" })}
                  </p>
                  <p className="tnum mt-1 text-[12.5px] text-ink">
                    {Math.round(day.minC)}° / {Math.round(day.maxC)}°
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-faint">{describe(day.code)}</p>
                  <p className="tnum mt-1.5 text-[13px] text-solar">
                    {expected === null ? "—" : `~${expected.toFixed(1)} kWh`}
                  </p>
                </div>
              );
            })}
          </div>
          <p className="text-[11.5px] text-ink-faint">
            Esperado = horas sol pico del pronóstico × {pvCapacityKwp ?? "—"} kWp × 80% de rendimiento.
          </p>
        </div>
      )}
    </Card>
  );
}
