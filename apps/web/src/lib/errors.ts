/** Anything thrown, as an Error. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** The stable `kind` the wasm puts on what it throws, if `value` has one. */
export function errorKind(value: unknown): string | undefined {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? kind : undefined;
}
