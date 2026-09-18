import { z } from "zod";

/**
 * Server environment — the only place the SolaX credentials are read.
 *
 * These names are the contract with `.env`. Nothing here is ever bundled into
 * the client: Vite only inlines variables prefixed `VITE_`, and none of these
 * are, so a build cannot leak them even by accident.
 *
 * Why this matters more than usual: the OAuth2 client_credentials grant returns
 * `scope: all`, which includes the inverter CONTROL endpoints — forced
 * charge/discharge, work mode, export limits. The secret is write access to the
 * hardware.
 */
const schema = z.object({
  /**
   * Regional API host. Global accounts use openapi-eu, China uses openapi-cn;
   * the correct one is shown under "My Account" in the Developer Portal.
   */
  SOLAX_BASE_URL: z
    .string()
    .url("SOLAX_BASE_URL must be a full URL, e.g. https://openapi-eu.solaxcloud.com")
    .refine((value) => !value.endsWith("/"), {
      message: "SOLAX_BASE_URL must not end in a slash",
    }),

  /** Client ID from the application you created in the Developer Portal. */
  SOLAX_CLIENT_ID: z.string().min(1, "SOLAX_CLIENT_ID is required"),

  /** Client Secret from that same application. Never commit it. */
  SOLAX_CLIENT_SECRET: z.string().min(1, "SOLAX_CLIENT_SECRET is required"),

  /**
   * Residential (1) or Commercial & Industrial (4). This changes the UNITS the
   * API returns — residential reports power in W, C&I in kW — so the mappers
   * read it rather than guessing.
   */
  SOLAX_BUSINESS_TYPE: z.coerce.number().int().refine((v) => v === 1 || v === 4, {
    message: "SOLAX_BUSINESS_TYPE must be 1 (Residential) or 4 (C&I)",
  }),

  /**
   * Local call budget, kept comfortably under the account's real limits so a
   * bug or a runaway loop cannot spend the quota.
   *
   * The plan on this account allows 100/min and 1,000,000/day. The defaults
   * here are deliberately lower: the dashboard needs roughly 1,000 calls a day
   * with the whole thing open continuously, so 20,000 leaves a 20x margin and
   * still stops anything pathological long before it matters.
   */
  SOLAX_MAX_CALLS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  SOLAX_MAX_CALLS_PER_DAY: z.coerce.number().int().positive().default(20_000),

  /**
   * Basic-auth credentials for the whole app. Optional locally, but set them on
   * any public deploy: without them anyone with the URL can read the plant data
   * and overwrite the CFE readings.
   */
  APP_USER: z.string().min(1).optional(),
  APP_PASSWORD: z.string().min(1).optional(),

  PORT: z.coerce.number().int().positive().default(8787),

  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export type Env = z.infer<typeof schema>;

/**
 * Loads `.env` into `process.env`.
 *
 * Node 22 ships `process.loadEnvFile()`, so this needs no dotenv dependency and
 * works however the process was started — `tsx`, plain `node`, or a container
 * entrypoint. Without it `loadEnv` reads an empty `process.env` and reports
 * every variable as missing even though the file is sitting right there.
 *
 * A missing file is NOT an error: in production the variables usually come from
 * the environment itself, and `loadEnv` will report anything still absent.
 */
export function loadDotEnv(path = ".env"): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fails at startup with every missing variable named at once, rather than
 * surfacing later as a confusing 401 from SolaX.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid server environment:\n${problems}\n\n` +
        `Copy .env.example to .env and fill it in. See the Developer Portal ` +
        `application page for the client id and secret.`,
    );
  }

  return parsed.data;
}

/** Redacted form, safe to log on boot so misconfiguration is visible. */
export function describeEnv(env: Env): string {
  const tail = env.SOLAX_CLIENT_ID.slice(-4);
  return [
    `base url      ${env.SOLAX_BASE_URL}`,
    `client id     ****${tail}`,
    `client secret ${env.SOLAX_CLIENT_SECRET ? "set" : "MISSING"}`,
    `business type ${env.SOLAX_BUSINESS_TYPE === 1 ? "1 (Residential, W)" : "4 (C&I, kW)"}`,
    `call budget   ${env.SOLAX_MAX_CALLS_PER_MINUTE}/min · ${env.SOLAX_MAX_CALLS_PER_DAY.toLocaleString("en-US")}/day (local cap)`,
    `port          ${env.PORT}`,
  ].join("\n");
}
