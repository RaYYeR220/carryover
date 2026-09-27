import type { Autonomy, CallSummary, CallTarget, Fact } from '@carryover/protocol';
import { createStore, get as idbGet, update as idbUpdate } from 'idb-keyval';

/**
 * Local-first user data. The profile vault (facts about the user) and the call
 * history live in IndexedDB on this device and never leave it until the user
 * shares a fact for a call.
 */

/** Minimal async key-value backend, so tests and fallbacks can swap IndexedDB out. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  update<T>(key: string, fn: (old: T | undefined) => T): Promise<void>;
}

export function memoryKv(): KV {
  const m = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return structuredClone(m.get(key)) as T | undefined;
    },
    async update<T>(key: string, fn: (old: T | undefined) => T) {
      m.set(key, structuredClone(fn(structuredClone(m.get(key)) as T | undefined)));
    },
  };
}

function localStorageKv(prefix: string): KV {
  const read = <T>(key: string): T | undefined => {
    const raw = localStorage.getItem(prefix + key);
    return raw == null ? undefined : (JSON.parse(raw) as T);
  };
  return {
    async get<T>(key: string) {
      return read<T>(key);
    },
    async update<T>(key: string, fn: (old: T | undefined) => T) {
      localStorage.setItem(prefix + key, JSON.stringify(fn(read<T>(key))));
    },
  };
}

function idbKv(): KV {
  const store = createStore('carryover', 'kv');
  return {
    get: <T>(key: string) => idbGet<T>(key, store),
    update: <T>(key: string, fn: (old: T | undefined) => T) => idbUpdate<T>(key, fn, store),
  };
}

let defaultKv: KV | null = null;
/** IndexedDB when available, else localStorage, else memory. Opened on first use. */
function lazyDefaultKv(): KV {
  const pick = (): KV => {
    if (defaultKv) return defaultKv;
    try {
      if (typeof indexedDB !== 'undefined') defaultKv = idbKv();
      else if (typeof localStorage !== 'undefined') defaultKv = localStorageKv('carryover.');
    } catch {
      defaultKv = null;
    }
    defaultKv ??= memoryKv();
    return defaultKv;
  };
  return {
    get: (key) => pick().get(key),
    update: (key, fn) => pick().update(key, fn),
  };
}

/* ---------- vault ---------- */

const VAULT_KEY = 'vault';
const LIMITS = { key: 40, label: 60, value: 200 } as const;

function cleanFact(f: Fact): Fact {
  const out: Fact = { key: f.key.trim(), label: f.label.trim(), value: f.value.trim() };
  for (const field of ['key', 'label', 'value'] as const) {
    const len = out[field].length;
    if (len < 1 || len > LIMITS[field]) {
      throw new RangeError(`Fact ${field} must be 1–${LIMITS[field]} characters`);
    }
  }
  return out;
}

export interface Vault {
  list(): Promise<Fact[]>;
  /** Insert, or replace the fact with the same key in place. */
  save(fact: Fact): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createVault(kv: KV): Vault {
  return {
    async list() {
      return [...((await kv.get<Fact[]>(VAULT_KEY)) ?? [])];
    },
    async save(fact) {
      const f = cleanFact(fact);
      await kv.update<Fact[]>(VAULT_KEY, (old = []) => {
        const i = old.findIndex((x) => x.key === f.key);
        if (i === -1) return [...old, f];
        const next = [...old];
        next[i] = f;
        return next;
      });
    },
    async remove(key) {
      await kv.update<Fact[]>(VAULT_KEY, (old = []) => old.filter((x) => x.key !== key));
    },
  };
}

/* ---------- history ---------- */

const HISTORY_KEY = 'history';
const HISTORY_MAX = 200;

/** A finished call as shown in history: the server summary plus what was dialled and how. */
export interface HistoryEntry extends CallSummary {
  target: CallTarget;
  mode: Autonomy;
}

export interface History {
  /** Newest first. */
  list(): Promise<HistoryEntry[]>;
  get(callId: string): Promise<HistoryEntry | undefined>;
  /** Insert, or replace the entry for the same call. Keeps the newest 200. */
  save(entry: HistoryEntry): Promise<void>;
}

export function createHistory(kv: KV): History {
  const all = async () => (await kv.get<HistoryEntry[]>(HISTORY_KEY)) ?? [];
  return {
    async list() {
      return [...(await all())].sort((a, b) => b.startedAt - a.startedAt);
    },
    async get(callId) {
      return (await all()).find((e) => e.callId === callId);
    },
    async save(entry) {
      await kv.update<HistoryEntry[]>(HISTORY_KEY, (old = []) =>
        [...old.filter((e) => e.callId !== entry.callId), entry]
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, HISTORY_MAX),
      );
    },
  };
}

const kv = lazyDefaultKv();
export const vault: Vault = createVault(kv);
export const history: History = createHistory(kv);

/* ---------- per-call app token (sessionStorage) ---------- */

const tokenKey = (callId: string) => `carryover.token.${callId}`;

export function saveCallToken(callId: string, token: string): void {
  try {
    sessionStorage.setItem(tokenKey(callId), token);
  } catch {
    // Storage can be unavailable (private mode, quota); the call page will say the call ended.
  }
}

export function loadCallToken(callId: string): string | null {
  try {
    return sessionStorage.getItem(tokenKey(callId));
  } catch {
    return null;
  }
}

export function clearCallToken(callId: string): void {
  try {
    sessionStorage.removeItem(tokenKey(callId));
  } catch {
    // ignore
  }
}
