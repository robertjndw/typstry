import {
  UnzipLimitError,
  unzipWithLimits,
  type UnzipRequest,
  type UnzipResponse,
} from "./unzip-limits";

self.onmessage = (e: MessageEvent<UnzipRequest>) => {
  let response: UnzipResponse;
  const transfer = new Set<ArrayBuffer>();
  try {
    const entries = unzipWithLimits(new Uint8Array(e.data.zip), e.data.limits);
    // Stored (uncompressed) entries are views into the input buffer, so
    // several entries can share one buffer; each may only be listed once.
    for (const [, bytes] of entries) transfer.add(bytes.buffer as ArrayBuffer);
    response = { ok: true, entries };
  } catch (err) {
    response =
      err instanceof UnzipLimitError
        ? { ok: false, message: err.message, limit: { paths: err.paths } }
        : { ok: false, message: String(err) };
  }
  self.postMessage(response, { transfer: [...transfer] });
};
