import { zipSync, type Zippable } from "fflate";

export interface ZipRequest {
  files: Zippable;
  mtime: number;
}

export type ZipResponse =
  { ok: true; zip: Uint8Array<ArrayBuffer> } | { ok: false; message: string };

self.onmessage = (e: MessageEvent<ZipRequest>) => {
  let response: ZipResponse;
  const transfer: ArrayBuffer[] = [];
  try {
    const zip = zipSync(e.data.files, { level: 6, mtime: e.data.mtime });
    transfer.push(zip.buffer as ArrayBuffer);
    response = { ok: true, zip: zip as Uint8Array<ArrayBuffer> };
  } catch (err) {
    response = { ok: false, message: String(err) };
  }
  self.postMessage(response, { transfer });
};
