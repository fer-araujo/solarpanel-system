import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  isIsoDate,
  lastDayOfMonth,
  latestAcceptableDate,
  utcToday,
} from "../../core/billing/model/calendar";
import {
  assertPeriodsUsable,
  assertReadingsUsable,
  type MeterReading,
  type PeriodBill,
} from "../../core/billing/model/meter-reading";
import type { KeyValueStore } from "../storage/kv";

/**
 * Persistence for the CFE meter readings and billing periods.
 *
 * This is the one thing the SolaX API cannot supply, because the inverter has
 * no meter of its own — the numbers come off the meter and the bill by hand. A
 * JSON document is the right size for that: no server to run, trivially backed
 * up, and readable by a human if it ever needs fixing.
 *
 * Version 2 keys readings by DAY and keeps the billing periods explicitly, by
 * CFE cut date, each with the recibo that closed it. Version 1 keyed readings
 * by calendar month, so two readings in one month overwrote each other and
 * every month was treated as a bill. Old documents are migrated when parsed,
 * so the local file and the Upstash key both keep working; the untouched v1
 * document is backed up before the first write replaces it.
 *
 * Writes to the file go to a temp file and are renamed over the target, so an
 * interrupted write cannot leave a truncated file where the history used to be.
 */

const MONTH = /^\d{4}-\d{2}$/;

/** A real calendar day, `YYYY-MM-DD`: the shape alone accepts 2026-02-31. */
export const isoDateSchema = z
  .string()
  .refine(isIsoDate, "must be a real date, YYYY-MM-DD");

const readingSchema = z.object({
  takenOn: isoDateSchema,
  importRegister: z.number().nonnegative(),
  exportRegister: z.number().nonnegative(),
  inferred: z.boolean().optional(),
});

/** What a client may send: the day is always a real one, never inferred. */
const readingInputSchema = readingSchema.omit({ inferred: true });

const billSchema = z.object({
  kwh: z.number().nonnegative(),
  totalMxn: z.number().nonnegative(),
  energyMxn: z.number().nonnegative().optional(),
  ivaMxn: z.number().nonnegative().optional(),
});

const periodSchema = z.object({
  start: isoDateSchema,
  end: isoDateSchema.nullable(),
  /** The recibo that closed the period. The bill history is derived from it. */
  bill: billSchema.optional(),
});

/**
 * Consumption per bimester as printed in the recibo's "consumo histórico",
 * labelled by the month the bill was cut in — the bills from BEFORE the new
 * meter. Bills captured when closing a period live on the period instead.
 *
 * Kept apart from `readings` on purpose. The old meter was consumption-only and
 * its registers do not continue into the new bidirectional one (20,703 then
 * 61), so folding it into the reading series would break the bank arithmetic.
 * The DAC test only needs consumption per period, which is exactly this.
 */
const historySchema = z.object({
  period: z.string().regex(MONTH, "period must be YYYY-MM"),
  kwh: z.number().nonnegative(),
  amountMxn: z.number().nonnegative().optional(),
});

const fileSchema = z.object({
  version: z.literal(2),
  /** Unbilled kWh carried over when a meter was replaced. */
  carryoverKwh: z.number().default(0),
  /** Day the bidirectional meter went in: the start of the first period. */
  meterInstalledOn: isoDateSchema.optional(),
  /** Contiguous, oldest first; only the last may be open. */
  periods: z.array(periodSchema).default([]),
  readings: z.array(readingSchema).default([]),
  history: z.array(historySchema).default([]),
});

/** The version-1 document, accepted only to be migrated. */
const fileSchemaV1 = z.object({
  version: z.literal(1),
  carryoverKwh: z.number().default(0),
  meterInstalledOn: isoDateSchema.optional(),
  readings: z
    .array(
      z.object({
        period: z.string().regex(MONTH, "period must be YYYY-MM"),
        importRegister: z.number().nonnegative(),
        exportRegister: z.number().nonnegative(),
        takenOn: isoDateSchema.optional(),
      }),
    )
    .default([]),
  history: z.array(historySchema).default([]),
});

export type ReadingsFile = z.infer<typeof fileSchema>;

/**
 * A request the stored data cannot accept, with the reason written for the
 * person filling in the form. 400 for bad input, 409 when it contradicts
 * something already recorded.
 */
export class ReadingsError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.name = "ReadingsError";
    this.status = status;
  }
}

function isV1(raw: unknown): boolean {
  return fileSchemaV1.safeParse(raw).success;
}

/**
 * v1 → v2. A reading without a day gets the last day of its month — the
 * latest it can have been taken, so no reading moves before one that really
 * came earlier — but never a day after `today`, and it is marked `inferred`.
 * One period is opened at the meter's install date (or the earliest reading),
 * because v1 never recorded where a bill was cut; closing it is left to the
 * user, with the recibo in hand.
 */
export function migrateReadingsFile(raw: unknown, today: string = utcToday()): unknown {
  const v1 = fileSchemaV1.safeParse(raw);
  if (!v1.success) return raw;

  const readings = v1.data.readings
    .map((reading) => {
      if (reading.takenOn) {
        return {
          takenOn: reading.takenOn,
          importRegister: reading.importRegister,
          exportRegister: reading.exportRegister,
        };
      }
      const lastDay = lastDayOfMonth(reading.period);
      return {
        takenOn: lastDay < today ? lastDay : today,
        importRegister: reading.importRegister,
        exportRegister: reading.exportRegister,
        inferred: true,
      };
    })
    .sort((a, b) => a.takenOn.localeCompare(b.takenOn));
  const start = v1.data.meterInstalledOn ?? readings[0]?.takenOn;

  return {
    version: 2,
    carryoverKwh: v1.data.carryoverKwh,
    ...(v1.data.meterInstalledOn ? { meterInstalledOn: v1.data.meterInstalledOn } : {}),
    periods: start ? [{ start, end: null }] : [],
    readings,
    history: v1.data.history,
  };
}

/**
 * A FUNCTION, not a shared constant.
 *
 * This was a spread of a module-level `EMPTY` object, and because a spread is
 * shallow the returned `readings` aliased that constant's array. `upsert` then
 * pushed into it, so once any caller hit the missing-file path every later
 * "empty" file in the process came back carrying stale rows.
 */
function emptyFile(): ReadingsFile {
  return { version: 2, carryoverKwh: 0, periods: [], readings: [], history: [] };
}

/** Chronological order is what the bank depends on, so it is enforced, not trusted. */
function normalise(file: ReadingsFile): ReadingsFile {
  file.readings.sort((a, b) => a.takenOn.localeCompare(b.takenOn));
  file.periods.sort((a, b) => a.start.localeCompare(b.start));
  file.history.sort((a, b) => a.period.localeCompare(b.period));
  return file;
}

/** Turns a domain assertion into a 400 with its message. */
function checked(run: () => void): void {
  try {
    run();
  } catch (error) {
    throw new ReadingsError(error instanceof Error ? error.message : String(error));
  }
}

/** Meter readings and cut dates come from the past; tomorrow is a typo. */
function assertNotFuture(date: string, what: string): void {
  if (date > latestAcceptableDate()) {
    throw new ReadingsError(`${what} (${date}) está en el futuro.`);
  }
}

const sameBill = (a: { kwh: number; amountMxn?: number }, bill: PeriodBill) =>
  a.kwh === bill.kwh && (a.amountMxn === undefined || a.amountMxn === bill.totalMxn);

/**
 * The reading logic, independent of where the file lives. Locally that is a
 * JSON file; on Vercel the filesystem is ephemeral, so it is Upstash.
 */
export abstract class ReadingsRepository {
  /** Raw stored document, or null when nothing has been saved yet. */
  protected abstract readRaw(): Promise<unknown | null>;
  protected abstract writeRaw(file: ReadingsFile): Promise<void>;
  /** Keeps a copy of a v1 document, unless one was already kept. */
  protected abstract backupV1Once(raw: unknown): Promise<void>;
  protected abstract describe(): string;

  async load(): Promise<ReadingsFile> {
    const raw = await this.readRaw();
    if (raw === null) return emptyFile();

    const parsed = fileSchema.safeParse(migrateReadingsFile(raw));
    if (!parsed.success) {
      throw new Error(
        `${this.describe()} is not a valid readings file: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return normalise(parsed.data);
  }

  async save(file: ReadingsFile): Promise<ReadingsFile> {
    const validated = normalise(fileSchema.parse(file));
    // The first write after a migration replaces the only copy of the v1
    // document. Kept aside first, so a migration bug can be undone by hand.
    const stored = await this.readRaw();
    if (stored !== null && isV1(stored)) await this.backupV1Once(stored);
    await this.writeRaw(validated);
    return validated;
  }

  /**
   * Adds a reading, or replaces the one already taken that day. Registers are
   * cumulative, so the new value must sit between its neighbours.
   */
  async upsert(reading: MeterReading): Promise<ReadingsFile> {
    const validated = readingInputSchema.parse(reading);
    assertNotFuture(validated.takenOn, "La lectura");
    const file = await this.load();

    const first = file.periods[0];
    const start = first?.start ?? file.meterInstalledOn;
    if (start && validated.takenOn < start) {
      throw new ReadingsError(
        `La lectura del ${validated.takenOn} es anterior al inicio del primer periodo (${start}).`,
      );
    }

    // A cut-date reading is what a closed period was settled with; changing
    // it would silently rewrite a bill already paid.
    const existing = file.readings.find((r) => r.takenOn === validated.takenOn);
    const closes = file.periods.some((period) => period.end === validated.takenOn);
    if (
      closes &&
      existing &&
      (existing.importRegister !== validated.importRegister ||
        existing.exportRegister !== validated.exportRegister)
    ) {
      throw new ReadingsError(
        `La lectura del ${validated.takenOn} cierra un periodo facturado; deshaz ese cierre para corregirla.`,
        409,
      );
    }

    file.readings = file.readings.filter((r) => r.takenOn !== validated.takenOn);
    file.readings.push(validated);
    normalise(file);
    checked(() => assertReadingsUsable(file.readings));

    // The first reading opens the first period when nothing else defined it.
    if (file.periods.length === 0) {
      file.periods.push({ start: file.meterInstalledOn ?? validated.takenOn, end: null });
    }
    return this.save(file);
  }

  async remove(takenOn: string): Promise<ReadingsFile> {
    const file = await this.load();
    // A cut-date reading is what a closed period's figures are computed from;
    // removing it would silently break the whole bank history.
    if (file.periods.some((period) => period.end === takenOn)) {
      throw new ReadingsError(
        `La lectura del ${takenOn} cierra un periodo facturado y no se puede borrar.`,
        409,
      );
    }
    file.readings = file.readings.filter((reading) => reading.takenOn !== takenOn);
    return this.save(file);
  }

  /**
   * Closes the open period at its cut date with what the recibo printed, and
   * opens the next one starting that same day. The reading taken on the cut
   * date is the closing reading, so it must exist first.
   *
   * The bill is kept ON the period, and the bill history is derived from it,
   * so undoing the close undoes the bill too and the history stays the
   * recibo's own pre-meter record.
   */
  async closePeriod(end: string, bill: PeriodBill): Promise<ReadingsFile> {
    const validatedBill = billSchema.parse(bill);
    if (!isIsoDate(end)) throw new ReadingsError(`La fecha de corte (${end}) no es una fecha real.`);
    assertNotFuture(end, "La fecha de corte");
    const file = await this.load();
    const open = file.periods.at(-1);
    if (!open || open.end !== null) {
      throw new ReadingsError("No hay un periodo abierto que cerrar.", 409);
    }
    if (end <= open.start) {
      throw new ReadingsError(
        `La fecha de corte (${end}) debe ser posterior al inicio del periodo (${open.start}).`,
      );
    }
    if (!file.readings.some((reading) => reading.takenOn === end)) {
      throw new ReadingsError(
        `Falta la lectura del ${end}: captura primero los registros del día de corte.`,
      );
    }
    const recorded = file.history.find((row) => row.period === end.slice(0, 7));
    if (recorded && !sameBill(recorded, validatedBill)) {
      throw new ReadingsError(
        `El historial ya tiene un recibo de ${end.slice(0, 7)} con ${recorded.kwh} kWh` +
          `${recorded.amountMxn === undefined ? "" : ` y $${recorded.amountMxn}`}; revisa cuál es el correcto.`,
        409,
      );
    }

    open.end = end;
    open.bill = validatedBill;
    file.periods.push({ start: end, end: null });
    checked(() => assertPeriodsUsable(file.periods));
    return this.save(file);
  }

  /**
   * Undoes the most recent close: the period reopens without its bill, and the
   * period the close opened disappears — but only while nothing was recorded
   * in it, so no reading is ever orphaned.
   */
  async reopenLastPeriod(): Promise<ReadingsFile> {
    const file = await this.load();
    const next = file.periods.at(-1);
    const closed = file.periods.at(-2);
    if (!next || next.end !== null || !closed || closed.end === null) {
      throw new ReadingsError("No hay un periodo cerrado que reabrir.", 409);
    }
    const cut = closed.end;
    const later = file.readings.filter((reading) => reading.takenOn > cut);
    if (later.length > 0) {
      throw new ReadingsError(
        `El periodo siguiente ya tiene lecturas (${later.map((r) => r.takenOn).join(", ")}); ` +
          `bórralas antes de deshacer el cierre.`,
        409,
      );
    }

    file.periods.pop();
    closed.end = null;
    delete closed.bill;
    return this.save(file);
  }

  async updateMeter(patch: {
    carryoverKwh?: number;
    meterInstalledOn?: string;
  }): Promise<ReadingsFile> {
    const file = await this.load();
    if (patch.carryoverKwh !== undefined) file.carryoverKwh = patch.carryoverKwh;
    if (patch.meterInstalledOn !== undefined) {
      assertNotFuture(patch.meterInstalledOn, "La fecha de instalación");
      file.meterInstalledOn = patch.meterInstalledOn;
      // The install date IS the first period's start; keep them in step.
      const first = file.periods[0];
      if (first && (first.end === null || patch.meterInstalledOn < first.end)) {
        first.start = patch.meterInstalledOn;
      } else if (!first) {
        file.periods.push({ start: patch.meterInstalledOn, end: null });
      }
    }
    return this.save(file);
  }
}

/** Local: a human-readable JSON file, written atomically. */
export class ReadingsStore extends ReadingsRepository {
  private readonly path: string;
  private readonly backupPath: string;

  constructor(dataDir: string) {
    super();
    this.path = join(dataDir, "cfe-readings.json");
    this.backupPath = join(dataDir, "cfe-readings.v1.bak.json");
  }

  protected describe(): string {
    return this.path;
  }

  protected async readRaw(): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as unknown;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  protected async writeRaw(file: ReadingsFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Temp file + rename: an interrupted write never truncates the history.
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temp, this.path);
  }

  protected async backupV1Once(raw: unknown): Promise<void> {
    try {
      // "wx": create only, so an existing backup is never overwritten.
      await writeFile(this.backupPath, `${JSON.stringify(raw, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
}

/** Serverless: one Upstash key, since the filesystem does not persist. */
export class KvReadingsStore extends ReadingsRepository {
  private static readonly KEY = "cfe-readings";
  private static readonly BACKUP_KEY = "cfe-readings.v1.bak";

  constructor(private readonly kv: KeyValueStore) {
    super();
  }

  protected describe(): string {
    return `Upstash key "${KvReadingsStore.KEY}"`;
  }

  protected readRaw(): Promise<unknown | null> {
    return this.kv.get<unknown>(KvReadingsStore.KEY);
  }

  protected async writeRaw(file: ReadingsFile): Promise<void> {
    await this.kv.set(KvReadingsStore.KEY, file);
  }

  protected async backupV1Once(raw: unknown): Promise<void> {
    if ((await this.kv.get<unknown>(KvReadingsStore.BACKUP_KEY)) === null) {
      await this.kv.set(KvReadingsStore.BACKUP_KEY, raw);
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

export { readingInputSchema, billSchema, fileSchema };
