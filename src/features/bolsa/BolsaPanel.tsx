import type { UseQueryResult } from "@tanstack/react-query";
import type { BillingSummaryResponse } from "@/api/client";
import { Card } from "@/ui/primitives/Card";
import { RowsSkeleton, StatSkeleton } from "@/ui/primitives/Skeleton";

/**
 * The CFE side of the picture: the energy bank, when it runs dry, and how close
 * the account is to DAC.
 *
 * This is the part no SolaX screen can show, because it comes off the bill. The
 * depletion projection is the point of the whole panel — "how much credit do I
 * have" is a number, "when do I start paying again" is a decision.
 */

const CONFIDENCE_LABEL: Record<string, string> = {
  none: "esperando datos",
  provisional: "provisional · 1 bimestre",
  fair: "razonable · 3+ bimestres",
  good: "sólido · 6+ bimestres",
};

/**
 * The metrics that are impossible instantaneously without a meter, but exact
 * once a period closes: `load = PV + imported - exported`.
 */
function BalanceSummary({
  balance,
}: {
  balance: NonNullable<BillingSummaryResponse["balance"]>;
}) {
  const broken = balance.periods.filter((period) => !period.consistent);
  // The most recent period, with its raw figures: what the house used of the
  // solar, what went to the grid and what came from it.
  const latest = [...balance.periods].reverse().find((period) => period.consistent) ?? null;

  return (
    <div className="rounded-xl border border-solar/25 bg-solar/5 px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium tracking-[0.08em] text-ink-faint uppercase">
          Balance real del periodo
        </p>
        <span className="text-[11px] text-ink-faint">
          {CONFIDENCE_LABEL[balance.confidence] ?? balance.confidence}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <p className="tnum text-[20px] leading-none font-medium text-solar">
            {balance.averageSelfSufficiency === null
              ? "—"
              : `${balance.averageSelfSufficiency.toFixed(0)}%`}
          </p>
          <p className="mt-1.5 text-[11.5px] text-ink-faint">Autosuficiencia</p>
        </div>
        <div>
          <p className="tnum text-[20px] leading-none font-medium text-batt">
            {balance.averageSelfConsumption === null
              ? "—"
              : `${balance.averageSelfConsumption.toFixed(0)}%`}
          </p>
          <p className="mt-1.5 text-[11.5px] text-ink-faint">Autoconsumo</p>
        </div>
        <div>
          <p className="tnum text-[20px] leading-none font-medium text-ink">
            {balance.averageDailyLoadKwh === null
              ? "—"
              : balance.averageDailyLoadKwh.toFixed(1)}
          </p>
          <p className="mt-1.5 text-[11.5px] text-ink-faint">kWh/día en casa</p>
        </div>
      </div>

      {latest && (
        <div className="mt-3 rounded-lg border border-line/50 bg-void/40 px-3 py-2.5">
          <p className="text-[11.5px] text-ink-faint">
            {latest.period}
            {latest.days !== null && ` · ${latest.days} días hasta tu última lectura`}
          </p>
          <dl className="tnum mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-4">
            <div>
              <dt className="text-ink-faint">Generado</dt>
              <dd className="text-solar">{latest.pvGeneratedKwh.toFixed(1)} kWh</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Usado en casa del solar</dt>
              <dd className="text-ink">{latest.selfConsumedKwh.toFixed(1)} kWh</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Exportado a la red</dt>
              <dd className="text-grid">{latest.exportedKwh.toFixed(1)} kWh</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Consumo total de la casa</dt>
              <dd className="text-ink">{latest.loadKwh.toFixed(1)} kWh</dd>
            </div>
          </dl>
          {latest.note && <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">{latest.note}</p>}
        </div>
      )}

      <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
        Calculado, no medido:{" "}
        <span className="tnum text-ink-dim">
          consumo = generación + importado − exportado
        </span>
        . Sin batería el balance cierra exacto, así que estas tres cifras son reales pese a
        no haber medidor. Lo que un recibo no puede decir es el reparto momento a momento.
      </p>

      {broken.length > 0 && (
        <p className="mt-2 text-[12px] leading-relaxed text-grid">
          {broken.length === 1
            ? `${broken[0]?.period}: ${broken[0]?.inconsistency}`
            : `${broken.length} periodos no cuadran y quedaron fuera del promedio.`}
        </p>
      )}
    </div>
  );
}

function DacMeter({ dac }: { dac: NonNullable<BillingSummaryResponse["dac"]> }) {
  const pct = Math.min(100, dac.utilisation * 100);
  const tone = dac.exceeded
    ? "bg-alert"
    : dac.approaching
      ? "bg-grid"
      : "bg-solar";

  return (
    <div>
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-ink-dim">Promedio móvil 12 meses</span>
        <span className="tnum text-ink">
          {dac.trailingAverageKwh.toFixed(0)} / {dac.limitKwhPerMonth} kWh·mes
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-line/60">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
        {dac.exceeded ? (
          <>
            <span className="text-alert">Estás por encima del límite DAC.</span> Sin
            subsidio la tarifa sube a ~6–7 MXN/kWh más cuota fija.
          </>
        ) : dac.approaching ? (
          <>
            <span className="text-grid">
              Te quedan {dac.headroomKwhPerMonth.toFixed(0)} kWh·mes de margen.
            </span>{" "}
            Cruzar el límite multiplica el recibo.
          </>
        ) : (
          <>Margen de {dac.headroomKwhPerMonth.toFixed(0)} kWh·mes antes del DAC.</>
        )}
      </p>
      <p className="mt-1.5 text-[11.5px] text-ink-faint">
        Calculado sobre consumo{" "}
        <span className="text-ink-dim">
          {dac.basis === "gross" ? "bruto" : "facturado"}
        </span>
        . CFE no documenta cuál usa con medición neta, y eso decide si el solar te protege
        del DAC o no.
      </p>
    </div>
  );
}

export function BolsaPanel({
  query,
}: {
  query: UseQueryResult<BillingSummaryResponse, Error>;
}) {
  const data = query.data;

  if (query.isError) {
    return (
      <Card title="Bolsa energética CFE">
        <p className="text-[13px] text-ink-dim">{query.error.message}</p>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card title="Bolsa energética CFE">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <StatSkeleton key={i} />
            ))}
          </div>
          <RowsSkeleton rows={2} />
        </div>
      </Card>
    );
  }

  if (data.periods.length === 0) {
    return (
      <Card title="Bolsa energética CFE" hint="Se alimenta de tus lecturas del recibo">
        <p className="py-6 text-center text-[13px] leading-relaxed text-ink-faint">
          Sin lecturas todavía. Captura los dos registros acumulados de tu medidor
          bidireccional — <span className="text-ink-dim">consumo</span> y{" "}
          <span className="text-ink-dim">retorno</span> — de cada recibo bimestral, y aquí
          aparece tu bolsa, la proyección de cuándo se agota y la cercanía al DAC.
        </p>
      </Card>
    );
  }

  const last = data.periods[data.periods.length - 1];
  const projection = data.projection;
  /** No credit and something being billed: this is a warning, not a balance. */
  const empty = (last?.bankKwh ?? 0) <= 0 && (last?.billedKwh ?? 0) > 0;
  const currency = data.currency ?? "MXN";
  const money = new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });
  const totalSavings =
    data.savings?.reduce((sum, entry) => sum + entry.amount, 0) ?? null;

  return (
    <Card
      title="Bolsa energética CFE"
      hint={`Tarifa ${data.tariff.code} · lecturas bimestrales del medidor`}
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div>
            <p className="text-[11px] font-medium tracking-[0.08em] text-ink-faint uppercase">
              Crédito disponible
            </p>
            <p className="mt-2 flex items-baseline gap-1.5">
              <span
                className={`tnum text-[38px] leading-none font-medium ${
                  empty ? "text-alert" : "text-solar"
                }`}
              >
                {last?.bankKwh.toFixed(0) ?? "0"}
              </span>
              <span className="text-[13px] text-ink-dim">kWh</span>
            </p>
            <p className="mt-1.5 text-[12px] text-ink-faint">
              al cierre de {last?.period}
            </p>
          </div>

          {empty ? (
            // Already empty: a "runs out on…" projection is meaningless here.
            <div className="rounded-lg border border-alert/30 bg-alert/5 px-3.5 py-3">
              <p className="text-[12.5px] leading-relaxed text-ink-dim">
                <span className="text-alert">Sin crédito en la bolsa.</span> Este periodo CFE
                te cobra{" "}
                <span className="tnum text-alert">{last?.billedKwh.toFixed(0)} kWh</span>. La
                bolsa empieza a llenarse cuando tu medidor registre más retorno que consumo.
              </p>
            </div>
          ) : projection?.depletesAt ? (
            <div className="rounded-lg border border-grid/25 bg-grid/5 px-3.5 py-3">
              <p className="text-[12.5px] leading-relaxed text-ink-dim">
                Al ritmo de los últimos {projection.periodsSampled} bimestres
                {" "}(<span className="tnum text-grid">
                  {projection.averageNetKwh.toFixed(0)} kWh
                </span>{" "}
                por periodo), tu bolsa se agota alrededor de{" "}
                <span className="tnum text-grid">{projection.depletesAt}</span> y vuelves a
                pagar kWh.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-solar/25 bg-solar/5 px-3.5 py-3">
              <p className="text-[12.5px] leading-relaxed text-ink-dim">
                Tu bolsa está creciendo: exportas más de lo que importas. Ojo con la
                caducidad, los créditos vencen al año de generarse.
              </p>
            </div>
          )}

          {totalSavings !== null && (
            <div>
              <p className="text-[11px] font-medium tracking-[0.08em] text-ink-faint uppercase">
                Ahorro acumulado
              </p>
              <p className="tnum mt-1.5 text-[20px] font-medium text-ink">
                {money.format(totalSavings)}
              </p>
              {!data.tariff.verified && (
                <p className="mt-1.5 text-[11.5px] text-grid">
                  Provisional: los bloques de la tarifa aún no se han capturado desde un
                  recibo real.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-5">
          {data.balance && data.balance.periods.length > 0 && (
            <BalanceSummary balance={data.balance} />
          )}

          {data.dac && <DacMeter dac={data.dac} />}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[440px] text-[12px]">
              <thead>
                <tr className="border-b border-line/60 text-left text-ink-faint">
                  <th className="pb-2 font-medium">Periodo</th>
                  <th className="pb-2 text-right font-medium">Importado</th>
                  <th className="pb-2 text-right font-medium">Exportado</th>
                  <th className="pb-2 text-right font-medium">Neto</th>
                  <th className="pb-2 text-right font-medium">Bolsa</th>
                  <th className="pb-2 text-right font-medium">Facturado</th>
                </tr>
              </thead>
              <tbody className="tnum">
                {data.periods.map((period) => (
                  <tr key={period.period} className="border-b border-line/30">
                    <td className="py-2 text-ink-dim">{period.period}</td>
                    <td className="py-2 text-right text-ink-dim">
                      {period.importedKwh.toFixed(0)}
                    </td>
                    <td className="py-2 text-right text-ink-dim">
                      {period.exportedKwh.toFixed(0)}
                    </td>
                    <td
                      className={`py-2 text-right ${
                        period.netKwh >= 0 ? "text-solar" : "text-grid"
                      }`}
                    >
                      {period.netKwh > 0 ? "+" : ""}
                      {period.netKwh.toFixed(0)}
                    </td>
                    <td className="py-2 text-right text-ink">
                      {period.bankKwh.toFixed(0)}
                    </td>
                    <td
                      className={`py-2 text-right ${
                        period.billedKwh > 0 ? "text-alert" : "text-ink-faint"
                      }`}
                    >
                      {period.billedKwh.toFixed(0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.periods.some((period) => period.expiredKwh > 0) && (
            <p className="text-[12px] text-ink-faint">
              Créditos caducados por la regla del año móvil:{" "}
              <span className="tnum text-grid">
                {data.periods
                  .reduce((sum, period) => sum + period.expiredKwh, 0)
                  .toFixed(0)}{" "}
                kWh
              </span>
              .
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
