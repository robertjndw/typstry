import {
  UnzipLimitError,
  unzipWithLimits,
  type UnzipLimits,
  type UnzipRequest,
  type UnzipResponse,
} from "./unzip-limits";

export { UnzipLimitError, type UnzipLimits } from "./unzip-limits";

/**
 * Unpacks a zip off the main thread; inflating a large archive would
 * otherwise freeze the page. Falls back to the main thread where there are
 * no workers (tests).
 */
export function unzip(
  zip: ArrayBuffer,
  limits: UnzipLimits,
): Promise<[string, Uint8Array][]> {
  if (typeof Worker === "undefined") {
    return new Promise((resolve) =>
      resolve(unzipWithLimits(new Uint8Array(zip), limits)),
    );
  }
  const worker = new Worker(new URL("./unzip.worker.ts", import.meta.url), {
    type: "module",
    name: "unzip",
  });
  return new Promise<[string, Uint8Array][]>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<UnzipResponse>) => {
      if (e.data.ok) resolve(e.data.entries);
      else if (e.data.limit)
        reject(new UnzipLimitError(e.data.message, e.data.limit.paths));
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || "unzip failed"));
    const request: UnzipRequest = { zip, limits };
    worker.postMessage(request, [zip]);
  }).finally(() => worker.terminate());
}
