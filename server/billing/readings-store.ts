import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { MeterReading } from "../../core/billing/model/meter-reading";
import type { KeyValueStore } from "../storage/kv";

/**
 * Persistence for the CFE meter readings.
 *
 * This is the one thing the SolaX API cannot supply, because the inverter has
 * no meter of its own — the numbers come off the bill by hand, roughly six rows
 * a year. A JSON file is the right size for that: no schema migrations, no
 * server to run, trivially backed up, and readable by a human if it ever needs
 * fixing.
 *
 * Writes go to a temp file and are renamed over the target, so an interrupted
 * write cannot leave a truncated file where the history used to be.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const readingSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM"),
  importRegister: z.number().nonnegative(),
  exportRegister: z.number().nonnegative(),
  takenOn: z.string().regex(DATE, "takenOn must be YYYY-MM-DD").optional(),
});

/**
 * Consumption per bimester as printed in the recibo's "consumo histórico".
 *
 * Kept apart from `readings` on purpose. The old meter was consumption-only and
 * its registers do not continue into the new bidirectional one (20,703 then
 * 61), so folding it into the reading series would break the bank arithmetic.
 * The DAC test only needs consumption per period, which is exactly this.
 */
const historySchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM"),
  kwh: z.number().nonnegative(),
  amountMxn: z.number().nonnegative().optional(),
});

const fileSchema = z.object({
  version: z.literal(1),
  /** Unbilled kWh carried over when a meter was replaced. */
  carryoverKwh: z.number().default(0),
  /** Day the bidirectional meter went in: the start of the first period. */
  meterInstalledOn: z.string().regex(DATE).optional(),
  readings: z.array(readingSchema).default([]),
  history: z.array(historySchema).default([]),
});

export type ReadingsFile = z.infer<typeof fileSchema>;

/**
 * A FUNCTION, not a shared constant.
 *
 * This was a spread of a module-level `EMPTY` object, and because a spread is
 * shallow the returned `readings` aliased that constant's array. `upsert` then
 * pushed into it, so once any caller hit the missing-file path every later
 * "empty" file in the process came back carrying stale rows.
 */
function emptyFile(): ReadingsFile {
  return { version: 1, carryoverKwh: 0, readings: [], history: [] };
}

/**
 * The reading logic, independent of where the file lives. Locally that is a
 * JSON file; on Vercel the filesystem is ephemeral, so it is Upstash.
 */
export abstract class ReadingsRepository {
  /** Raw stored document, or null when nothing has been saved yet. */
  protected abstract readRaw(): Promise<unknown | null>;
  protected abstract writeRaw(file: ReadingsFile): Promise<void>;
  protected abstract describe(): string;

  async load(): Promise<ReadingsFile> {
    const raw = await this.readRaw();
    if (raw === null) return emptyFile();

    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `${this.describe()} is not a valid readings file: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    // Chronological order is what the bolsa calculation depends on, so it is
    // guaranteed here rather than trusted from storage.
    parsed.data.readings.sort((a, b) => a.period.localeCompare(b.period));
    return parsed.data;
  }

  async save(file: ReadingsFile): Promise<ReadingsFile> {
    const validated = fileSchema.parse(file);
    validated.readings.sort((a, b) => a.period.localeCompare(b.period));
    await this.writeRaw(validated);
    return validated;
  }

  /** Adds a reading, or replaces the one already recorded for that period. */
  async upsert(reading: MeterReading): Promise<ReadingsFile> {
    const validated = readingSchema.parse(reading);
    const file = await this.load();
    const index = file.readings.findIndex((r) => r.period === validated.period);
    if (index >= 0) file.readings[index] = validated;
    else file.readings.push(validated);
    return this.save(file);
  }

  async remove(period: string): Promise<ReadingsFile> {
    const file = await this.load();
    file.readings = file.readings.filter((reading) => reading.period !== period);
    return this.save(file);
  }

  async updateMeter(patch: {
    carryoverKwh?: number;
    meterInstalledOn?: string;
  }): Promise<ReadingsFile> {
    const file = await this.load();
    if (patch.carryoverKwh !== undefined) file.carryoverKwh = patch.carryoverKwh;
    if (patch.meterInstalledOn !== undefined) file.meterInstalledOn = patch.meterInstalledOn;
    return this.save(file);
  }

  async setCarryover(carryoverKwh: number): Promise<ReadingsFile> {
    return this.updateMeter({ carryoverKwh });
  }
}

/** Local: a human-readable JSON file, written atomically. */
export class ReadingsStore extends ReadingsRepository {
  private readonly path: string;

  constructor(dataDir: string) {
    super();
    this.path = join(dataDir, "cfe-readings.json");
  }

  protected describe(): string {
    return this.path;
  }

  protected async readRaw(): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as unknown;
    } catch (error) {
      if (isNotFound(error)) return null;
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
}

/** Serverless: one Upstash key, since the filesystem does not persist. */
export class KvReadingsStore extends ReadingsRepository {
  private static readonly KEY = "cfe-readings";

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
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export { readingSchema, fileSchema };
