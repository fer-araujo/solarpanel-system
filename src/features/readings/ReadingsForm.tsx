import { useState } from "react";
import type { MeterReading } from "@core/billing/model/meter-reading";
import {
  useDeleteReading,
  useReadings,
  useSaveMeter,
  useSaveReading,
} from "@/api/queries";
import { Card } from "@/ui/primitives/Card";

/**
 * Capture for the CFE meter — the one data source the SolaX API cannot supply
 * on a plant with no meter or CT.
 *
 * Each reading carries the exact DAY it was taken, because the energy balance
 * sums daily PV between consecutive readings; a month label alone lined up
 * weeks of meter against whatever days SolaX happened to have.
 *
 * Values are CUMULATIVE registers, so a late entry loses nothing.
 */

interface Draft {
  takenOn: string;
  importRegister: string;
  exportRegister: string;
}

const EMPTY: Draft = { takenOn: "", importRegister: "", exportRegister: "" };
const today = () => new Date().toISOString().slice(0, 10);

const inputClass =
  "tnum mt-1.5 w-full rounded-lg border border-line bg-raised px-3 py-2 text-[13px] text-ink outline-none focus:border-solar/60";
const labelClass =
  "block text-[11px] font-medium tracking-[0.07em] text-ink-faint uppercase";

export function ReadingsForm() {
  const { data: file } = useReadings();
  const saveReading = useSaveReading();
  const deleteReading = useDeleteReading();
  const saveMeter = useSaveMeter();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);
  const [carryover, setCarryover] = useState<string | null>(null);

  const readings = file?.readings ?? [];

  function validate(): MeterReading | string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.takenOn)) return "Elige el día en que leíste el medidor.";
    const importRegister = Number(draft.importRegister);
    const exportRegister = Number(draft.exportRegister);
    if (!draft.importRegister.trim() || !(importRegister >= 0)) return "Consumo debe ser ≥ 0.";
    if (!draft.exportRegister.trim() || !(exportRegister >= 0)) return "Retorno debe ser ≥ 0.";

    const earlier = readings
      .filter((r) => (r.takenOn ?? r.period) < draft.takenOn)
      .at(-1);
    if (earlier && (importRegister < earlier.importRegister || exportRegister < earlier.exportRegister)) {
      return `Las lecturas son acumuladas y no pueden bajar respecto a ${earlier.takenOn ?? earlier.period}.`;
    }
    return { period: draft.takenOn.slice(0, 7), importRegister, exportRegister, takenOn: draft.takenOn };
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = validate();
    if (typeof result === "string") return setError(result);
    setError(null);
    saveReading.mutate(result, {
      onSuccess: () => setDraft(EMPTY),
      onError: (e) => setError(e.message),
    });
  }

  return (
    <Card title="Lecturas del medidor CFE" hint="Cuando llegue el recibo o cuando quieras · el orden no importa">
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,170px)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div>
            <label htmlFor="r-date" className={labelClass}>Día de la lectura</label>
            <input id="r-date" type="date" max={today()} value={draft.takenOn}
              onChange={(e) => setDraft((d) => ({ ...d, takenOn: e.target.value }))} className={inputClass} />
          </div>
          <div>
            <label htmlFor="r-import" className={labelClass}>Consumo (kWh)</label>
            <input id="r-import" type="number" min="0" step="1" inputMode="decimal" placeholder="acumulado"
              value={draft.importRegister}
              onChange={(e) => setDraft((d) => ({ ...d, importRegister: e.target.value }))} className={inputClass} />
          </div>
          <div>
            <label htmlFor="r-export" className={labelClass}>Retorno (kWh)</label>
            <input id="r-export" type="number" min="0" step="1" inputMode="decimal" placeholder="acumulado"
              value={draft.exportRegister}
              onChange={(e) => setDraft((d) => ({ ...d, exportRegister: e.target.value }))} className={inputClass} />
          </div>
          <div>
            <button type="submit" disabled={saveReading.isPending}
              className="w-full rounded-lg border border-solar/40 bg-solar/10 px-4 py-2 text-[13px] font-medium text-solar hover:bg-solar/20 disabled:opacity-50 sm:w-auto">
              {saveReading.isPending ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
        {error && <p role="alert" className="text-[12.5px] text-alert">{error}</p>}
      </form>

      {readings.length > 0 && (
        <table className="tnum mt-4 w-full border-t border-line/50 text-[12.5px]">
          <thead>
            <tr className="text-left text-ink-faint">
              <th className="py-2 font-medium">Día</th>
              <th className="py-2 text-right font-medium">Consumo</th>
              <th className="py-2 text-right font-medium">Retorno</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {readings.map((r) => (
              <tr key={r.period} className="border-t border-line/30">
                <td className={`py-2 ${r.takenOn ? "text-ink-dim" : "text-grid"}`}>
                  {r.takenOn ?? `${r.period} · sin día`}
                </td>
                <td className="py-2 text-right text-ink">{r.importRegister}</td>
                <td className="py-2 text-right text-ink">{r.exportRegister}</td>
                <td className="py-2 text-right">
                  <button type="button" className="mr-3 text-[12px] text-ink-dim hover:text-ink"
                    onClick={() => setDraft({ takenOn: r.takenOn ?? "", importRegister: String(r.importRegister), exportRegister: String(r.exportRegister) })}>
                    Editar
                  </button>
                  <button type="button" className="text-[12px] text-ink-faint hover:text-alert"
                    onClick={() => deleteReading.mutate(r.period)}>
                    Borrar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="mt-4 grid items-end gap-3 border-t border-line/50 pt-4 sm:grid-cols-[minmax(0,200px)_minmax(0,200px)_auto]">
        <div>
          <label htmlFor="m-installed" className={labelClass}>Medidor nuevo desde</label>
          <input id="m-installed" type="date" max={today()} className={inputClass}
            value={installed ?? file?.meterInstalledOn ?? ""} onChange={(e) => setInstalled(e.target.value)} />
        </div>
        <div>
          <label htmlFor="m-carry" className={labelClass}>Arrastre (kWh)</label>
          <input id="m-carry" type="number" min="0" step="1" className={inputClass}
            value={carryover ?? String(file?.carryoverKwh ?? 0)} onChange={(e) => setCarryover(e.target.value)} />
        </div>
        <div>
          <button type="button" disabled={(installed === null && carryover === null) || saveMeter.isPending}
            onClick={() =>
              saveMeter.mutate(
                {
                  ...(installed ? { meterInstalledOn: installed } : {}),
                  ...(carryover !== null && Number(carryover) >= 0 ? { carryoverKwh: Number(carryover) } : {}),
                },
                { onSuccess: () => { setInstalled(null); setCarryover(null); } },
              )
            }
            className="rounded-lg border border-line px-3.5 py-2 text-[13px] text-ink-dim hover:text-ink disabled:opacity-40">
            Guardar
          </button>
        </div>
      </div>
      <p className="mt-2 text-[12px] text-ink-faint">
        La fecha de instalación marca el inicio del primer periodo. Sin ella el balance real no se calcula.
      </p>
    </Card>
  );
}
