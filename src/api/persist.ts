import type {
  PersistedClient,
  Persister,
  PersistQueryClientOptions,
} from "@tanstack/react-query-persist-client";
import { getAuthClient } from "./auth";

/**
 * Persists the query cache to localStorage, so a reload paints the last
 * values at once and refetches quietly instead of opening on skeletons while a
 * burst of SolaX calls goes out.
 *
 * The copy is stored PER USER (keyed by Firebase uid) and wiped whenever the
 * session ends, so one account's plant and readings never paint for another
 * on a shared device. The session itself is never persisted (Firebase owns
 * it), nor are mutations. The buster changes with every build, so a deploy
 * that reshapes a response never feeds the new code an old shape.
 */

/** How long a persisted cache may paint the dashboard after a reload. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const KEY_PREFIX = "solar-dashboard-cache:";
/** The pre-scoping key, removed with the rest on sign-out. */
const LEGACY_KEY = "solar-dashboard-cache";
/** Coalesces the burst of cache updates a page load produces into one write. */
const WRITE_THROTTLE_MS = 1_000;

/**
 * Tags Dates so they survive the trip through JSON. Snapshots carry
 * `power.at` as a Date, and a restored string would break every component
 * that formats it.
 */
function serializeClient(client: PersistedClient): string {
  return JSON.stringify(client, function (this: Record<string, unknown>, key, value: unknown) {
    const raw = this[key];
    return raw instanceof Date ? { $date: raw.toISOString() } : value;
  });
}

function deserializeClient(text: string): PersistedClient {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value === "object" && value !== null && "$date" in value) {
      const tagged = value as { $date: unknown };
      if (typeof tagged.$date === "string" && Object.keys(value).length === 1) {
        return new Date(tagged.$date);
      }
    }
    return value;
  }) as PersistedClient;
}

/** Null where storage is unavailable (private mode, blocked site data). */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The signed-in user's key, "local" when auth is disabled (local dev), or
 * null when nobody is signed in — in which case nothing is read or written.
 */
async function scopedKey(): Promise<string | null> {
  try {
    const auth = await getAuthClient();
    if (!auth) return `${KEY_PREFIX}local`;
    const uid = auth.currentUser?.uid;
    return uid ? `${KEY_PREFIX}${uid}` : null;
  } catch {
    return null;
  }
}

let pendingWrite: PersistedClient | null = null;
let writeTimer: ReturnType<typeof setTimeout> | undefined;

async function flush(): Promise<void> {
  writeTimer = undefined;
  const client = pendingWrite;
  pendingWrite = null;
  const storage = browserStorage();
  const key = await scopedKey();
  if (!client || !storage || !key) return;
  try {
    storage.setItem(key, serializeClient(client));
  } catch {
    // Quota exceeded or storage blocked: persistence is a convenience.
  }
}

const persister: Persister = {
  persistClient(client) {
    pendingWrite = client;
    writeTimer ??= setTimeout(() => void flush(), WRITE_THROTTLE_MS);
  },
  async restoreClient() {
    const storage = browserStorage();
    const key = await scopedKey();
    if (!storage || !key) return undefined;
    const text = storage.getItem(key);
    if (!text) return undefined;
    try {
      return deserializeClient(text);
    } catch {
      storage.removeItem(key);
      return undefined;
    }
  },
  removeClient: () => clearPersistedCache(),
};

export const persistOptions: Omit<PersistQueryClientOptions, "queryClient"> = {
  persister,
  maxAge: PERSIST_MAX_AGE_MS,
  buster: __APP_BUILD__,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) =>
      query.state.status === "success" && query.queryKey[0] !== "auth",
    shouldDehydrateMutation: () => false,
  },
};

/**
 * Forgets every persisted copy, for every user, and drops a write that was
 * still waiting: called whenever the session ends, when the uid that scoped
 * the copy may already be gone.
 */
export function clearPersistedCache(): void {
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = undefined;
  pendingWrite = null;
  const storage = browserStorage();
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && (key.startsWith(KEY_PREFIX) || key === LEGACY_KEY)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage blocked: there is nothing to clear either.
  }
}
