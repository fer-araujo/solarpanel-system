import type { KeyValueStore } from "../storage/kv";
import {
  SOLAX_OK_AUTH,
  SolaxError,
  tokenResultSchema,
  unwrapEnvelope,
} from "@core/solax/dto/envelope";

/**
 * Holds the access token.
 *
 * The client_credentials grant returns a token good for ~30 days and calling
 * the endpoint again does NOT extend the current one — it issues a new one. So
 * the token is cached and only refreshed when it is genuinely near expiry.
 *
 * Two properties matter here:
 *
 * 1. Single-flight. A cold start that fans out into six dashboard requests must
 *    produce ONE token call, not six. Concurrent callers await the same promise.
 * 2. Preemptive refresh. Refreshing a little early costs one call a month and
 *    avoids every caller eating a 10402 round trip at the boundary.
 *
 * In memory only, on purpose: no persistence means no token on disk to leak,
 * and re-authenticating after a restart is a single request.
 */

export interface TokenStoreOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Refresh this far before the token actually expires. */
  refreshMarginMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * Where the token survives a serverless cold start. Without it every fresh
   * instance would request a new 30-day token.
   */
  persistence?: KeyValueStore;
}

const PERSISTED_KEY = "solax-token";

interface CachedToken {
  value: string;
  expiresAt: number;
  /**
   * The API service packages this application is subscribed to, e.g.
   * "API_Telemetry_V2 API_Info_V2 API_Overall_V2". Access is limited by this,
   * so a missing package explains a call failing even with valid credentials.
   */
  scope: string | null;
  authStation: string | null;
}

const DEFAULT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // one day

export class TokenStore {
  private readonly options: Required<Omit<TokenStoreOptions, "fetchImpl" | "persistence">> & {
    fetchImpl: typeof fetch;
  };
  private readonly persistence: KeyValueStore | null;
  private cached: CachedToken | null = null;
  private inFlight: Promise<string> | null = null;
  /** Set by invalidate(): the persisted token was rejected, so do not reuse it. */
  private skipPersisted = false;

  constructor(options: TokenStoreOptions) {
    this.persistence = options.persistence ?? null;
    this.options = {
      baseUrl: options.baseUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshMarginMs: options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS,
      fetchImpl: options.fetchImpl ?? fetch,
      now: options.now ?? Date.now,
    };
  }

  async get(): Promise<string> {
    const { now, refreshMarginMs } = this.options;

    if (this.cached && this.cached.expiresAt - refreshMarginMs > now()) {
      return this.cached.value;
    }

    // Single-flight: whoever arrives during a refresh waits on the same call.
    this.inFlight ??= this.resolveToken().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  /** Persisted token first; SolaX only when there is none still valid. */
  private async resolveToken(): Promise<string> {
    const { now, refreshMarginMs } = this.options;
    if (this.persistence && !this.skipPersisted) {
      const stored = await this.persistence.get<CachedToken>(PERSISTED_KEY).catch(() => null);
      if (stored && stored.expiresAt - refreshMarginMs > now()) {
        this.cached = stored;
        return stored.value;
      }
    }
    this.skipPersisted = false;
    return this.fetchToken();
  }

  /** Forces a refresh on the next `get`. Used after a 10402. */
  invalidate(): void {
    this.cached = null;
    this.skipPersisted = true;
  }

  private async fetchToken(): Promise<string> {
    const { baseUrl, clientId, clientSecret, fetchImpl, now } = this.options;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    });

    const response = await fetchImpl(`${baseUrl}/openapi/auth/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*",
      },
      body,
    });

    if (!response.ok) {
      throw new SolaxError({
        code: response.status,
        message:
          `Token endpoint returned HTTP ${response.status}. ` +
          `Check SOLAX_BASE_URL is the region shown under "My Account".`,
        retryable: response.status >= 500,
      });
    }

    // The auth endpoint signals success with code 0, not 10000.
    const result = unwrapEnvelope(await response.json(), SOLAX_OK_AUTH);
    const parsed = tokenResultSchema.safeParse(result);
    if (!parsed.success) {
      throw new SolaxError({
        code: -1,
        message: `Token response was not in the documented shape: ${parsed.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      });
    }

    this.cached = {
      value: parsed.data.access_token,
      expiresAt: now() + parsed.data.expires_in * 1000,
      scope: parsed.data.scope ?? null,
      authStation: parsed.data.auth_station ?? null,
    };

    // Best effort: a failed write only means the next cold start re-authenticates.
    await this.persistence
      ?.set(PERSISTED_KEY, this.cached, this.cached.expiresAt - now())
      .catch(() => undefined);

    return this.cached.value;
  }

  snapshot(): {
    hasToken: boolean;
    expiresInMs: number | null;
    scope: string | null;
    scopes: string[];
    authStation: string | null;
  } {
    if (!this.cached) {
      return {
        hasToken: false,
        expiresInMs: null,
        scope: null,
        scopes: [],
        authStation: null,
      };
    }
    return {
      hasToken: true,
      expiresInMs: Math.max(0, this.cached.expiresAt - this.options.now()),
      scope: this.cached.scope,
      scopes: this.cached.scope ? this.cached.scope.split(/\s+/).filter(Boolean) : [],
      authStation: this.cached.authStation,
    };
  }
}
