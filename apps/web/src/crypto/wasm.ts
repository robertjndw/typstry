// The encryption and MLS group of crates/typstry-wire, built from
// crates/typstry-wasm by scripts/build-wasm.sh. Importing this pulls in the
// small JS glue only; the wasm itself (a few hundred KB gzipped) is fetched
// when something calls `loadWasm`, which project routes do before they touch
// a key. Home never does.
import init from "../../vendor/typstry-wasm/typstry_wasm.js";
import wasmUrl from "../../vendor/typstry-wasm/typstry_wasm_bg.wasm?url";

export * from "../../vendor/typstry-wasm/typstry_wasm.js";

let loading: Promise<void> | null = null;

/**
 * Fetches and compiles the wasm once. Resolves immediately when it was
 * initialized synchronously already, which is how the tests do it.
 */
export function loadWasm(): Promise<void> {
  loading ??= init({ module_or_path: wasmUrl }).then(
    () => undefined,
    (error: unknown) => {
      // A failed fetch (offline at the wrong moment) must not stick.
      loading = null;
      throw error;
    },
  );
  return loading;
}
