// Namespaced local persistence for per-device preferences.
// Storage can be unavailable (private mode, blocked site data): every access is guarded
// and the app must work without it. Later this interface can be backed by account sync
// or an iOS App Group without changing callers.

const PREFIX = 'fc.v2.';
const SCHEMA_KEY = `${PREFIX}schema`;
export const SCHEMA_VERSION = 1;

function backend(storage) {
  if (storage) return storage;
  // Browser storage only (window.localStorage); other runtimes get an inert store.
  try { return globalThis.window?.localStorage ?? null; } catch { return null; }
}

export function createStore(storage) {
  const target = backend(storage);

  const read = (key) => {
    try { return target ? target.getItem(PREFIX + key) : null; } catch { return null; }
  };
  const write = (key, value) => {
    try { if (target) target.setItem(PREFIX + key, value); return true; } catch { return false; }
  };

  return {
    get(key, fallback = null) {
      const value = read(key);
      return value === null ? fallback : value;
    },
    set(key, value) {
      return write(key, String(value));
    },
    getJSON(key, fallback = null) {
      const value = read(key);
      if (value === null) return fallback;
      try { return JSON.parse(value); } catch { return fallback; }
    },
    setJSON(key, value) {
      return write(key, JSON.stringify(value));
    },
    remove(key) {
      try { target?.removeItem(PREFIX + key); } catch { /* unavailable */ }
    },
    /** Removes every fc.v2.* key, leaving other origins' data untouched. */
    clearAll() {
      if (!target) return 0;
      let removed = 0;
      try {
        const keys = [];
        for (let i = 0; i < target.length; i += 1) {
          const key = target.key(i);
          if (key && key.startsWith(PREFIX)) keys.push(key);
        }
        for (const key of keys) { target.removeItem(key); removed += 1; }
      } catch { /* unavailable */ }
      return removed;
    },
    /** Records the schema version; returns the previously stored version (or null). */
    ensureSchema() {
      let previous = null;
      try { previous = target ? target.getItem(SCHEMA_KEY) : null; } catch { /* unavailable */ }
      try { target?.setItem(SCHEMA_KEY, String(SCHEMA_VERSION)); } catch { /* unavailable */ }
      return previous === null ? null : Number(previous);
    },
  };
}

export const store = createStore();
