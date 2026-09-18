import { CFE_1C } from "@core/billing/data/cfe-1c";
import { estimateDailySavings } from "@core/billing/services/savings";
import { environmentalBenefits } from "@core/energy/services/environment";
import { useBillingSummary, usePlantRealtime } from "@/api/queries";
import { Card } from "@/ui/primitives/Card";
import { Bone } from "@/ui/primitives/Skeleton";

/**
 * Savings and environmental impact.
 *
 * Savings are priced against the REAL bill: each solar kWh displaces a kWh from
 * the top of a typical bimester (from the last year of recibos), block by
 * block, plus IVA. The vendor's figure is kWh × a flat 4 pesos, which ignores
 * IVA and overstates once solar pushes the bill below the excedente block.
 */

const money = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 2,
});

export function ImpactCard() {
  const plantQuery = usePlantRealtime();
  const plant = plantQuery.data;
  const billing = useBillingSummary().data;

  const dailyKwh = plant?.dailyYield ?? null;
  const totalKwh = plant?.totalYield ?? null;
  const gross = billing?.averageBimonthlyKwh ?? null;

  const savings =
    dailyKwh !== null && gross !== null
      ? estimateDailySavings(dailyKwh, gross, CFE_1C.summer)
      : null;
  const lifetime = totalKwh === null ? null : environmentalBenefits(totalKwh);

  return (
    <Card title="Ahorro e impacto">
      <div className="space-y-4">
        <div>
          <p className="text-[11px] font-medium tracking-[0.08em] text-ink-faint uppercase">
            Ahorro estimado hoy
          </p>
          <p className="tnum mt-2 text-[30px] leading-none font-medium text-solar">
            {savings ? (
              money.format(savings.amount)
            ) : plantQuery.isPending ? (
              <Bone className="h-[30px] w-28" />
            ) : (
              "—"
            )}
          </p>
          <p className="mt-1.5 text-[12px] text-ink-faint">
            {savings
              ? `${dailyKwh?.toFixed(1)} kWh × ${money.format(savings.perKwh)}/kWh con IVA`
              : gross === null
                ? "Falta el historial de recibos"
                : "Esperando la producción del día"}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 border-t border-line/50 pt-3">
          {[
            ["CO₂ evitado", lifetime ? `${lifetime.co2Kg.toFixed(0)} kg` : "—"],
            ["Árboles·año", lifetime ? lifetime.treeYears.toFixed(1) : "—"],
            ["Carbón", lifetime ? `${lifetime.coalKg.toFixed(0)} kg` : "—"],
          ].map(([label, value]) => (
            <div key={label}>
              <p className="tnum text-[16px] text-ink">{value}</p>
              <p className="mt-1 text-[11px] text-ink-faint">{label}</p>
            </div>
          ))}
        </div>
        <p className="text-[11.5px] text-ink-faint">
          Impacto acumulado sobre {totalKwh?.toFixed(1) ?? "—"} kWh registrados en SolaX.
        </p>
      </div>
    </Card>
  );
}
