import { useState } from "react";
import { scaleLinear } from "d3-scale";
import { CFE_1C } from "@core/billing/data/cfe-1c";
import {
  DAYS_PER_BIMESTER,
  expectedBimonthlySolarKwh,
  projectBill,
  projectNextBill,
  valuePerSolarKwh,
} from "@core/billing/services/savings";
import { useBillingSummary, usePlantRealtime, useReadings, useTopology } from "@/api/queries";
import { Card } from "@/ui/primitives/Card";
import { ChartTooltip, TooltipRow } from "@/ui/primitives/ChartTooltip";
import { ChartSkeleton } from "@/ui/primitives/Skeleton";

/**
 * What CFE actually charged, bill by bill, plus what the panels change.
 *
 * The history comes straight from the recibo's "consumo histórico", so it is the
 * real pre-solar baseline. The projection prices the SAME bimester of last year
 * (seasonality matters: summer AC doubles consumption) with and without the
 * expected solar production.
 */

const W = 900;
const H = 220;
const M = { top: 22, right: 10, bottom: 34, left: 10 };
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
const label = (p: string) => `${MONTHS[Number(p.slice(5, 7)) - 1] ?? ""} ${p.slice(2, 4)}`;

function addMonths(period: string, months: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const z = y * 12 + (m - 1) + months;
  return `${Math.floor(z / 12)}-${String((z % 12) + 1).padStart(2, "0")}`;
}

function Stat({ title, value, tone, note }: { title: string; value: string; tone: string; note?: string }) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.07em] text-ink-faint uppercase">{title}</p>
      <p className={`tnum mt-1.5 text-[18px] font-medium ${tone}`}>{value}</p>
      {note && <p className="mt-0.5 text-[11.5px] text-ink-faint">{note}</p>}
    </div>
  );
}

export function BillHistory() {
  const readingsQuery = useReadings();
  const readings = readingsQuery.data;
  const billing = useBillingSummary().data;
  const history = readings?.history ?? [];
  const plant = usePlantRealtime().data;
  const capacity = useTopology().data?.pvCapacityKwp ?? null;
  const [hover, setHover] = useState<number | null>(null);

  if (readingsQuery.isPending) {
    return (
      <Card title="Gasto real en CFE">
        <ChartSkeleton height="h-[220px]" />
      </Card>
    );
  }
  if (history.length === 0) return null;

  const last12 = history.slice(-6);
  const paid12 = last12.reduce((s, b) => s + (b.amountMxn ?? 0), 0);
  const kwh12 = last12.reduce((s, b) => s + b.kwh, 0);
  const avgGross = kwh12 / last12.length;
  const worst = history.reduce((t, b) => ((b.amountMxn ?? 0) > (t.amountMxn ?? 0) ? b : t));

  const solarBimester = capacity === null ? null : expectedBimonthlySolarKwh(capacity);

  // Savings so far: every kWh SolaX has recorded, valued against a typical bill.
  const perKwh = solarBimester === null ? null : valuePerSolarKwh(avgGross, solarBimester, CFE_1C.summer);
  const savedSoFar = perKwh !== null && plant?.totalYield != null ? plant.totalYield * perKwh : null;

  // Same bimester one year earlier: the seasonal baseline.
  const lastPeriod = history[history.length - 1]?.period ?? "";
  const nextPeriod = addMonths(lastPeriod, 2);
  const baseline = history.find((b) => b.period === addMonths(nextPeriod, -12));
  const typical =
    baseline && solarBimester !== null ? projectBill(baseline.kwh, solarBimester, CFE_1C.summer) : null;

  // The bill actually coming: what the meter already owes, plus the days left.
  // Bills close on the 6th (per the recibo: 08 JUN – 06 AGO).
  const billedSoFar = billing?.periods.at(-1)?.billedKwh ?? null;
  const lastReadingDay = readings?.readings.at(-1)?.takenOn ?? null;
  const next =
    billedSoFar !== null && lastReadingDay && baseline && solarBimester !== null
      ? projectNextBill({
          billedSoFarKwh: billedSoFar,
          remainingDays: Math.round((Date.parse(`${nextPeriod}-06`) - Date.parse(lastReadingDay)) / 86_400_000),
          grossDailyKwh: baseline.kwh / DAYS_PER_BIMESTER,
          solarDailyKwh: solarBimester / DAYS_PER_BIMESTER,
          schedule: CFE_1C.summer,
        })
      : null;
  const yearly =
    solarBimester === null
      ? null
      : last12.reduce((s, b) => s + projectBill(b.kwh, solarBimester, CFE_1C.summer).saved, 0);

  const max = Math.max(...history.map((b) => b.amountMxn ?? 0), 1);
  const slot = (W - M.left - M.right) / history.length;
  const y = scaleLinear().domain([0, max * 1.12]).range([H - M.bottom, M.top]);
  const active = hover === null ? null : history[hover];

  return (
    <Card title="Gasto real en CFE" hint="Del consumo histórico de tu recibo · y lo que cambian los paneles">
      <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat title="Pagado 12 meses" value={money.format(paid12)} tone="text-grid" />
        <Stat title="Promedio por recibo" value={money.format(paid12 / last12.length)} tone="text-ink" />
        <Stat title="kWh 12 meses" value={kwh12.toLocaleString("es-MX")} tone="text-ink" />
        <Stat title="Recibo más caro" value={money.format(worst.amountMxn ?? 0)} tone="text-alert" note={label(worst.period)} />
      </div>

      {solarBimester !== null && (
        <div className="mb-5 grid gap-4 rounded-xl border border-solar/25 bg-solar/5 p-4 sm:grid-cols-3">
          <Stat title="Ahorrado con paneles" tone="text-solar"
            value={savedSoFar === null ? "—" : money.format(savedSoFar)}
            note={plant?.totalYield != null ? `${plant.totalYield.toFixed(1)} kWh generados` : undefined} />
          <Stat title="Ahorro esperado al año" tone="text-solar"
            value={yearly === null ? "—" : money.format(yearly)}
            note={`vs los ${money.format(paid12)} que pagaste`} />
          {next && (
            <div>
              <p className="text-[11px] tracking-[0.07em] text-ink-faint uppercase">Próximo recibo · {label(nextPeriod)}</p>
              <p className="tnum mt-1.5 text-[18px] font-medium text-alert">~{money.format(next.amount)}</p>
              <p className="mt-0.5 text-[11.5px] text-ink-faint">
                {next.kwh.toFixed(0)} kWh · casi todo es el arrastre · sin incluir la instalación del medidor
              </p>
            </div>
          )}
          {typical && baseline && (
            <p className="text-[11.5px] leading-relaxed text-ink-faint sm:col-span-3">
              A partir de ahí, un bimestre como {label(baseline.period)} ({baseline.kwh} kWh) bajaría de{" "}
              <span className="tnum text-ink-dim">{money.format(typical.withoutSolar)}</span> a{" "}
              <span className="tnum text-solar">~{money.format(typical.withSolar)}</span>
              {typical.withSolar < 70 ? " — el mínimo de CFE (50 kWh)" : ""}. Estimado con {capacity} kWp × 5 h sol × 80%
              ≈ {solarBimester.toFixed(0)} kWh por bimestre, bloques reales de la 1C más IVA.
            </p>
          )}
        </div>
      )}

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" onMouseLeave={() => setHover(null)}>
          <title>Importe pagado a CFE por bimestre</title>
          {history.map((bill, i) => {
            const amount = bill.amountMxn ?? 0;
            const x = M.left + i * slot + slot * 0.18;
            const width = slot * 0.64;
            const recent = i >= history.length - 6;
            return (
              <g key={bill.period} onMouseEnter={() => setHover(i)}>
                <rect x={M.left + i * slot} y={M.top} width={slot} height={H - M.top - M.bottom} fill="transparent" />
                <rect x={x} y={y(amount)} width={width} height={Math.max(0, y(0) - y(amount))} rx="3"
                  fill={recent ? "var(--color-grid)" : "var(--color-line)"}
                  fillOpacity={hover === null || hover === i ? 0.9 : 0.4} />
                <text x={x + width / 2} y={y(amount) - 6} textAnchor="middle" className="tnum" fontSize="10.5" fill="var(--color-ink-dim)">
                  {(amount / 1000).toFixed(1)}k
                </text>
                <text x={x + width / 2} y={H - 14} textAnchor="middle" fontSize="10.5" fill="var(--color-ink-faint)">
                  {label(bill.period)}
                </text>
              </g>
            );
          })}
        </svg>
        {active && hover !== null && (
          <ChartTooltip xPct={((M.left + (hover + 0.5) * slot) / W) * 100}>
            <p className="mb-1 font-medium text-ink">{label(active.period)}</p>
            <TooltipRow label="Pagado" value={money.format(active.amountMxn ?? 0)} color="var(--color-grid)" />
            <TooltipRow label="Consumo" value={`${active.kwh.toLocaleString("es-MX")} kWh`} />
          </ChartTooltip>
        )}
      </div>
      <p className="mt-2 text-[11.5px] text-ink-faint">Ámbar = últimos 12 meses.</p>
    </Card>
  );
}
