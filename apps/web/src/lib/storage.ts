// localStorage is only used for per-browser conveniences (identity, recent
// projects). It can be missing or throw (private mode, blocked site data,
// quota), so every access degrades to "nothing stored".

export function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readJson(
  key: string,
  storage: Storage | null = getStorage(),
): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeJson(
  key: string,
  value: unknown,
  storage: Storage | null = getStorage(),
): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisting a convenience value is fine.
  }
}
