import { z } from "zod";

/**
 * Every SolaX v2 business endpoint answers in the same envelope. Validating it
 * once, here, means the rest of the code never reads `code` or unwraps
 * `result` by hand.
 *
 * Note the inconsistency the API actually has: the OAuth token endpoint signals
 * success with `code: 0`, while every business endpoint uses `code: 10000`.
 * Both are handled rather than normalised away, because pretending they are the
 * same is how a silent failure gets through.
 */

export const SOLAX_OK_BUSINESS = 10000;
export const SOLAX_OK_AUTH = 0;

/** Codes from Appendix 1 of the V2 docs. */
export const SolaxCode = {
  okBusiness: 10000,
  failed: 10001,
  systemBusy: 11500,
  operationAbnormal: 10200,
  notAuthenticated: 10400,
  badCredentials: 10401,
  tokenInvalid: 10402,
  noInterfaceAccess: 10403,
  callbackNotConfigured: 10404,
  quotaExhausted: 10405,
  rateLimited: 10406,
  noDevicePermission: 10500,
  deviceUnauthorized: 10505,
  plantUnauthorized: 10506,
} as const;

export type SolaxCodeValue = (typeof SolaxCode)[keyof typeof SolaxCode];

export const envelopeSchema = z.object({
  code: z.number(),
  message: z.string().nullish(),
  traceId: z.string().nullish(),
  requestId: z.string().nullish(),
  result: z.unknown().nullish(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

export const tokenResultSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().nullish(),
  /** Seconds. The client_credentials grant returns ~2591999 (30 days). */
  expires_in: z.number(),
  scope: z.string().nullish(),
  grant_type: z.string().nullish(),
  auth_station: z.string().nullish(),
});

export type TokenResult = z.infer<typeof tokenResultSchema>;

/** A page of results, as the `page_*` endpoints return it. */
export function pagedSchema<T extends z.ZodTypeAny>(record: T) {
  return z.object({
    total: z.coerce.number().nullish(),
    pages: z.number().nullish(),
    current: z.number().nullish(),
    size: z.number().nullish(),
    records: z.array(record).nullish(),
  });
}

export class SolaxError extends Error {
  readonly code: number;
  readonly traceId: string | undefined;
  readonly retryable: boolean;

  constructor(options: {
    code: number;
    message: string;
    traceId?: string | undefined;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "SolaxError";
    this.code = options.code;
    this.traceId = options.traceId;
    this.retryable = options.retryable ?? false;
  }

  /** True when re-authenticating and retrying could plausibly succeed. */
  get isAuthProblem(): boolean {
    return (
      this.code === SolaxCode.tokenInvalid ||
      this.code === SolaxCode.notAuthenticated
    );
  }

  get isRateLimit(): boolean {
    return this.code === SolaxCode.rateLimited;
  }

  get isQuotaExhausted(): boolean {
    return this.code === SolaxCode.quotaExhausted;
  }
}

const HUMAN_MESSAGES: Record<number, string> = {
  [SolaxCode.failed]: "SolaX rejected the operation",
  [SolaxCode.systemBusy]: "SolaX is busy; try again shortly",
  [SolaxCode.notAuthenticated]: "Request was not authenticated",
  [SolaxCode.badCredentials]: "Client id or secret is wrong",
  [SolaxCode.tokenInvalid]: "Access token is invalid or expired",
  [SolaxCode.noInterfaceAccess]:
    "This endpoint is not in the account's API service package",
  [SolaxCode.quotaExhausted]: "Daily API call quota is exhausted",
  [SolaxCode.rateLimited]: "API call rate limit reached",
  [SolaxCode.noDevicePermission]: "Account has no permission for this device",
  [SolaxCode.deviceUnauthorized]: "Device is not authorised for this application",
  [SolaxCode.plantUnauthorized]: "Plant is not authorised for this application",
};

const RETRYABLE = new Set<number>([
  SolaxCode.systemBusy,
  SolaxCode.rateLimited,
  SolaxCode.tokenInvalid,
]);

/**
 * Unwraps an envelope or throws a typed error. `expectedOk` differs between the
 * auth and business endpoints, so the caller states which it expects.
 */
export function unwrapEnvelope(
  payload: unknown,
  expectedOk: number = SOLAX_OK_BUSINESS,
): unknown {
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new SolaxError({
      code: -1,
      message: `SolaX response did not match the documented envelope: ${envelope.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    });
  }

  const { code, message, traceId, result } = envelope.data;
  if (code !== expectedOk) {
    const detail = HUMAN_MESSAGES[code] ?? "Unexpected SolaX response code";
    throw new SolaxError({
      code,
      message: message ? `${detail} (${code}): ${message}` : `${detail} (${code})`,
      traceId: traceId ?? undefined,
      retryable: RETRYABLE.has(code),
    });
  }

  return result ?? null;
}
