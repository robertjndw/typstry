import { unzipSync } from "fflate";

export interface UnzipRequest {
  zip: ArrayBuffer;
}

export type UnzipResponse =
  | { ok: true; entries: [string, Uint8Array][] }
  | { ok: false; message: string };

/**
 * Unpacks a zip off the main thread; inflating a large archive would
 * otherwise freeze the page. Falls back to the main thread where there are
 * no workers (tests).
 */
export function unzip(zip: ArrayBuffer): Promise<[string, Uint8Array][]> {
  if (typeof Worker === "undefined") {
    return Promise.resolve(Object.entries(unzipSync(new Uint8Array(zip))));
  }
  const worker = new Worker(new URL("./unzip.worker.ts", import.meta.url), {
    type: "module",
    name: "unzip",
  });
  return new Promise<[string, Uint8Array][]>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<UnzipResponse>) => {
      if (e.data.ok) resolve(e.data.entries);
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || "unzip failed"));
    const request: UnzipRequest = { zip };
    worker.postMessage(request, [zip]);
  }).finally(() => worker.terminate());
}
