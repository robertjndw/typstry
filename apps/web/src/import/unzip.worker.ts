import { unzipSync } from "fflate";

import type { UnzipRequest, UnzipResponse } from "./unzip";

self.onmessage = (e: MessageEvent<UnzipRequest>) => {
  let response: UnzipResponse;
  const transfer = new Set<ArrayBuffer>();
  try {
    const entries = Object.entries(unzipSync(new Uint8Array(e.data.zip)));
    // Stored (uncompressed) entries are views into the input buffer, so
    // several entries can share one buffer; each may only be listed once.
    for (const [, bytes] of entries) transfer.add(bytes.buffer as ArrayBuffer);
    response = { ok: true, entries };
  } catch (err) {
    response = { ok: false, message: String(err) };
  }
  self.postMessage(response, { transfer: [...transfer] });
};
