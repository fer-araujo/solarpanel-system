import { SolaxError, unwrapEnvelope } from "@core/solax/dto/envelope";
import { RateLimiter, RateLimitExceededError } from "./rate-limiter";
import type { SharedBudget } from "./shared-budget";
import type { TokenStore } from "./token-store";

/**
 * The single door to the SolaX API.
 *
 * Responsibilities, all of which exist because the API misbehaves in specific
 * documented ways:
 *
 * - Attaches `Authorization: bearer <token>` (lowercase "bearer" — the docs are
 *   explicit that the first letter must be lowercase).
 * - Spends the local call budget before sending, so the daily quota is never
 *   burned by accident.
 * - On 10402 (token invalid) refreshes the token and retries ONCE. A second
 *   failure is a real credential problem and must surface.
 * - On 10406 (rate limited) records a local backoff so we stop pushing.
 * - On 10405 (quota exhausted) marks the day spent; nothing more will work.
 *
 * Retries are capped and never applied to a non-retryable code, because a
 * retry loop against a quota limit is how an account gets locked out all day.
 */

export interface SolaxHttpClientOptions {
  baseUrl: string;
  tokenStore: TokenStore;
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  /** Abort an individual request after this long. */
  timeoutMs?: number;
  /** Budget shared across server instances (Upstash); absent locally. */
  sharedBudget?: SharedBudget | null;
  /**
   * Minimum spacing between calls from this instance. Opening the dashboard
   * fires ~20 calls from parallel routes; spread out, they stop tripping
   * SolaX's burst limit (10406) and the 30-second backoff that follows.
   */
  minGapMs?: number;
}

export interface RequestOptions {
  /** Path starting with `/openapi/...`. */
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class SolaxHttpClient {
  readonly rateLimiter: RateLimiter;
  private readonly baseUrl: string;
  private readonly tokenStore: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sharedBudget: SharedBudget | null;
  private readonly minGapMs: number;
  /** Earliest moment the next call may start. */
  private nextSlot = 0;

  constructor(options: SolaxHttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.tokenStore = options.tokenStore;
    this.rateLimiter = options.rateLimiter ?? new RateLimiter();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sharedBudget = options.sharedBudget ?? null;
    this.minGapMs = options.minGapMs ?? 0;
  }

  /** Reserves the next start slot and waits for it, so calls go out spaced. */
  private async pace(): Promise<void> {
    if (this.minGapMs <= 0) return;
    const now = Date.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.minGapMs;
    if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
  }

  async request(options: RequestOptions): Promise<unknown> {
    try {
      return await this.send(options, false);
    } catch (error) {
      if (error instanceof SolaxError && error.isAuthProblem) {
        // The cached token was rejected. Refresh and try exactly once more.
        this.tokenStore.invalidate();
        return this.send(options, true);
      }
      throw error;
    }
  }

  private async send(options: RequestOptions, isRetry: boolean): Promise<unknown> {
    const { path, method = "GET", query, body, signal } = options;

    // Budget is spent before the call, not after, so a refusal costs nothing.
    this.rateLimiter.take();
    await this.pace();
    await this.sharedBudget?.take();

    const token = await this.tokenStore.get();
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          // Lowercase "bearer" is what the docs specify.
          Authorization: `bearer ${token}`,
          Accept: "*/*",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: composed,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new SolaxError({
          code: -1,
          message: `SolaX request to ${path} timed out after ${this.timeoutMs}ms`,
          retryable: true,
        });
      }
      throw error;
    }

    if (!response.ok) {
      throw new SolaxError({
        code: response.status,
        message: `SolaX ${method} ${path} returned HTTP ${response.status}`,
        retryable: response.status >= 500,
      });
    }

    // Read as text first so the raw body can be reported when something is
    // wrong. SolaX's generic codes (10001 "System exception") carry no detail,
    // and without the request that produced them the message is unactionable.
    const raw = await response.text();

    try {
      return unwrapEnvelope(JSON.parse(raw));
    } catch (error) {
      const where = `${method} ${url.pathname}${url.search}`;

      if (error instanceof SolaxError) {
        if (error.isRateLimit) {
          this.rateLimiter.penalise();
          void this.sharedBudget?.penalise();
        }
        if (error.isQuotaExhausted) this.rateLimiter.markQuotaExhausted();

        // An auth failure on the retry attempt is terminal; let it through
        // rather than looping.
        if (error.isAuthProblem && isRetry) {
          throw new SolaxError({
            code: error.code,
            message:
              `${error.message} on ${where}. A fresh token was also rejected, ` +
              `so check SOLAX_CLIENT_ID and SOLAX_CLIENT_SECRET.`,
            traceId: error.traceId,
          });
        }

        console.error(`[solax] ${where} -> ${raw.slice(0, 500)}`);
        throw new SolaxError({
          code: error.code,
          message: `${error.message} on ${where}`,
          traceId: error.traceId,
          retryable: error.retryable,
        });
      }

      if (error instanceof SyntaxError) {
        throw new SolaxError({
          code: -1,
          message: `SolaX returned non-JSON on ${where}: ${raw.slice(0, 200)}`,
        });
      }

      throw error;
    }
  }

  get(path: string, query?: RequestOptions["query"]): Promise<unknown> {
    return this.request({ path, method: "GET", ...(query ? { query } : {}) });
  }

  post(path: string, body?: unknown): Promise<unknown> {
    return this.request({ path, method: "POST", ...(body === undefined ? {} : { body }) });
  }
}

export { RateLimitExceededError };
