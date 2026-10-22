import { useState } from "react";
import {
  periodLabel,
  type BillingPeriod,
  type MeterReading,
} from "@core/billing/model/meter-reading";
import {
  useClosePeriod,
  useDeleteReading,
  useReadings,
  useSaveMeter,
  useSaveReading,
} from "@/api/queries";
import { Card } from "@/ui/primitives/Card";
import { Spinner } from "@/ui/primitives/Skeleton";

/**
 * Capture for the CFE meter — the one data source the SolaX API cannot supply
 * on a plant with no meter or CT.
 *
 * Readings are keyed by the DAY they were taken, and there can be as many per
 * billing period as anyone cares to take: they show how the open period is
 * going. Only the reading on the cut date settles a period, and that happens
 * explicitly, with the recibo in hand ("Cerrar periodo con recibo"), because
 * the cut date is CFE's, not the calendar's.
 *
 * Values are CUMULATIVE registers, so a late entry loses nothing.
 */

interface Draft {
  takenOn: string;
  importRegister: string;
  exportRegister: string;
}

interface CloseDraft {
  end: string;
  kwh: string;
  totalMxn: string;
}

const EMPTY: Draft = { takenOn: "", importRegister: "", exportRegister: "" };
const EMPTY_CLOSE: CloseDraft = { end: "", kwh: "", totalMxn: "" };
const today = () => new Date().toISOString().slice(0, 10);

const inputClass =
  "tnum mt-1.5 w-full rounded-lg border border-line bg-raised px-3 py-2 text-[13px] text-ink outline-none focus:border-solar/60";
const labelClass =
  "block text-[11px] font-medium tracking-[0.07em] text-ink-faint uppercase";

/**
 * Readings grouped under the period they belong to, newest period first. A
 * cut-date reading belongs to the period it closes; the first period also owns
 * a reading taken on its start day.
 */
function groupByPeriod(periods: BillingPeriod[], readings: MeterReading[]) {
  return periods
    .map((period, index) => ({
      period,
      readings: readings
        .filter(
          (r) =>
            (index === 0 ? r.takenOn >= period.start : r.takenOn > period.start) &&
            (period.end === null || r.takenOn <= period.end),
        )
        .reverse(),
    }))
    .reverse();
}

export function ReadingsForm() {
  const { data: file } = useReadings();
  const saveReading = useSaveReading();
  const deleteReading = useDeleteReading();
  const closePeriod = useClosePeriod();
  const saveMeter = useSaveMeter();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [closeDraft, setCloseDraft] = useState<CloseDraft>(EMPTY_CLOSE);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);
  const [carryover, setCarryover] = useState<string | null>(null);

  const readings = file?.readings ?? [];
  const periods = file?.periods ?? [];
  const open = periods.at(-1)?.end === null ? periods.at(-1) : undefined;
  const cutDates = new Set(periods.map((p) => p.end).filter((end): end is string => end !== null));

  function validate(): MeterReading | string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.takenOn)) return "Elige el día en que leíste el medidor.";
    const importRegister = Number(draft.importRegister);
    const exportRegister = Number(draft.exportRegister);
    if (!draft.importRegister.trim() || !(importRegister >= 0)) return "Consumo debe ser ≥ 0.";
    if (!draft.exportRegister.trim() || !(exportRegister >= 0)) return "Retorno debe ser ≥ 0.";

    // Cumulative registers: the new value must sit between both neighbours.
    const earlier = readings.filter((r) => r.takenOn < draft.takenOn).at(-1);
    if (earlier && (importRegister < earlier.importRegister || exportRegister < earlier.exportRegister)) {
      return `Las lecturas son acumuladas y no pueden bajar respecto al ${earlier.takenOn}.`;
    }
    const later = readings.find((r) => r.takenOn > draft.takenOn);
    if (later && (importRegister > later.importRegister || exportRegister > later.exportRegister)) {
      return `Las lecturas son acumuladas y no pueden superar las del ${later.takenOn}.`;
    }
    return { takenOn: draft.takenOn, importRegister, exportRegister };
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

  function onClose(event: React.FormEvent) {
    event.preventDefault();
    if (!open) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closeDraft.end)) return setCloseError("Elige la fecha de corte del recibo.");
    if (closeDraft.end <= open.start) {
      return setCloseError(`La fecha de corte debe ser posterior al ${open.start}.`);
    }
    if (!readings.some((r) => r.takenOn === closeDraft.end)) {
      return setCloseError(
        `Primero guarda la lectura del ${closeDraft.end} (los registros que trae el recibo).`,
      );
    }
    const kwh = Number(closeDraft.kwh);
    const totalMxn = Number(closeDraft.totalMxn);
    if (!closeDraft.kwh.trim() || !(kwh >= 0)) return setCloseError("kWh facturados debe ser ≥ 0.");
    if (!closeDraft.totalMxn.trim() || !(totalMxn >= 0)) return setCloseError("El total debe ser ≥ 0.");
    setCloseError(null);
    closePeriod.mutate(
      { end: closeDraft.end, bill: { kwh, totalMxn } },
      { onSuccess: () => setCloseDraft(EMPTY_CLOSE), onError: (e) => setCloseError(e.message) },
    );
  }

  return (
    <Card title="Lecturas del medidor CFE" hint="Las que quieras por periodo · el orden no importa">
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
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-solar/40 bg-solar/10 px-4 py-2 text-[13px] font-medium text-solar hover:bg-solar/20 disabled:opacity-50 sm:w-auto">
              {saveReading.isPending && <Spinner />}
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
          {groupByPeriod(periods, readings).map(({ period, readings: rows }) => (
            <tbody key={period.start}>
              <tr className="border-t border-line/50">
                <th colSpan={4} className="pt-3 pb-1 text-left text-[11px] font-medium tracking-[0.07em] text-ink-faint uppercase">
                  {periodLabel(period)} · {period.end === null ? "abierto" : `corte ${period.end}`}
                  {period.bill && ` · ${period.bill.kwh} kWh facturados`}
                </th>
              </tr>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-2 text-ink-faint">Sin lecturas en este periodo.</td>
                </tr>
              )}
              {rows.map((r) => {
                const isCut = cutDates.has(r.takenOn);
                return (
                  <tr key={r.takenOn} className="border-t border-line/30">
                    <td className="py-2 text-ink-dim">
                      {r.takenOn}
                      {isCut && <span className="ml-2 text-[11px] text-solar">corte</span>}
                    </td>
                    <td className="py-2 text-right text-ink">{r.importRegister}</td>
                    <td className="py-2 text-right text-ink">{r.exportRegister}</td>
                    <td className="py-2 text-right">
                      <button type="button" className="mr-3 text-[12px] text-ink-dim hover:text-ink"
                        onClick={() => setDraft({ takenOn: r.takenOn, importRegister: String(r.importRegister), exportRegister: String(r.exportRegister) })}>
                        Editar
                      </button>
                      <button type="button" disabled={isCut}
                        title={isCut ? "Cierra un periodo facturado" : undefined}
                        className="text-[12px] text-ink-faint hover:text-alert disabled:opacity-30 disabled:hover:text-ink-faint"
                        onClick={() => deleteReading.mutate(r.takenOn)}>
                        Borrar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      )}
      {deleteReading.isError && (
        <p role="alert" className="mt-2 text-[12.5px] text-alert">{deleteReading.error.message}</p>
      )}

      {open && (
        <form onSubmit={onClose} className="mt-4 space-y-3 border-t border-line/50 pt-4">
          <p className="text-[12.5px] text-ink-dim">
            Cerrar periodo con recibo <span className="text-ink-faint">· {periodLabel(open)}, desde el {open.start}</span>
          </p>
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,170px)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div>
              <label htmlFor="c-end" className={labelClass}>Fecha de corte</label>
              <input id="c-end" type="date" min={open.start} max={today()} value={closeDraft.end}
                onChange={(e) => setCloseDraft((d) => ({ ...d, end: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label htmlFor="c-kwh" className={labelClass}>kWh facturados</label>
              <input id="c-kwh" type="number" min="0" step="1" inputMode="decimal" value={closeDraft.kwh}
                onChange={(e) => setCloseDraft((d) => ({ ...d, kwh: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label htmlFor="c-total" className={labelClass}>Total a pagar ($)</label>
              <input id="c-total" type="number" min="0" step="0.01" inputMode="decimal" value={closeDraft.totalMxn}
                onChange={(e) => setCloseDraft((d) => ({ ...d, totalMxn: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <button type="submit" disabled={closePeriod.isPending}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-line px-4 py-2 text-[13px] text-ink-dim hover:text-ink disabled:opacity-50 sm:w-auto">
                {closePeriod.isPending && <Spinner />}
                Cerrar periodo
              </button>
            </div>
          </div>
          {closeError && <p role="alert" className="text-[12.5px] text-alert">{closeError}</p>}
          <p className="text-[12px] text-ink-faint">
            Usa la lectura del día de corte que trae el recibo. Al cerrar, el siguiente periodo empieza
            ese mismo día y el recibo se suma al historial.
          </p>
        </form>
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
            className="inline-flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-[13px] text-ink-dim hover:text-ink disabled:opacity-40">
            {saveMeter.isPending && <Spinner />}
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
