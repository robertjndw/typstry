import type { JumpTarget, PagePosition } from "./protocol";

/**
 * The jump methods our patched compiler build adds to typst.ts' wasm
 * TypstCompiler (patches/typst-ts-jump.patch). They answer from the last
 * paged document that compiled.
 */
export interface JumpCompiler {
  jump_from_click(page: number, x: number, y: number): unknown;
  jump_from_cursor(path: string, offset: number): unknown[];
}

/**
 * The wasm object behind typst.ts' compiler driver. The driver keeps it in
 * a public `compiler` field but its interface type does not list it.
 */
export function jumpCompiler(driver: unknown): JumpCompiler {
  return (driver as { compiler: JumpCompiler }).compiler;
}

interface RawJump {
  path?: string;
  package?: string;
  offset?: number;
  url?: string;
  page?: number;
  x?: number;
  y?: number;
}

export function toJumpTarget(raw: unknown): JumpTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as RawJump;
  if (typeof j.path === "string" && typeof j.offset === "number")
    return {
      kind: "source",
      path: j.path,
      package: j.package ?? "",
      offset: j.offset,
    };
  if (typeof j.url === "string") return { kind: "url", url: j.url };
  const position = toPagePosition(raw);
  return position ? { kind: "position", ...position } : null;
}

export function toPagePosition(raw: unknown): PagePosition | null {
  if (!raw || typeof raw !== "object") return null;
  const { page, x, y } = raw as RawJump;
  if (
    typeof page !== "number" ||
    typeof x !== "number" ||
    typeof y !== "number"
  )
    return null;
  return { page, x, y };
}
