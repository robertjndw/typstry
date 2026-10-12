import type { WebAssemblyModuleRef } from "@myriaddreamin/typst.ts/wasm";

/**
 * typst.ts hands `getModule()` straight to the wasm-bindgen init function,
 * which logs a deprecation warning for a bare URL and wants it wrapped in
 * `{ module_or_path }`. typst.ts 0.7's types do not know that form yet.
 */
export function wasmModuleRef(url: string): WebAssemblyModuleRef {
  return { module_or_path: url } as unknown as WebAssemblyModuleRef;
}
