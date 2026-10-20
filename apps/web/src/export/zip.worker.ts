import { zipSync, type Zippable } from "fflate";

import { unpackPackages, type PackageArchive } from "./unpack";

export interface ZipRequest {
  files: Zippable;
  packages: PackageArchive[];
  mtime: number;
}

export type ZipResponse =
  | { ok: true; zip: Uint8Array<ArrayBuffer>; left: string[] }
  | { ok: false; message: string };

self.onmessage = (e: MessageEvent<ZipRequest>) => {
  let response: ZipResponse;
  const transfer: ArrayBuffer[] = [];
  try {
    // Inflating packages here keeps their unpacked size off the main thread.
    const left = unpackPackages(e.data.packages, e.data.files);
    const zip = zipSync(e.data.files, { level: 6, mtime: e.data.mtime });
    transfer.push(zip.buffer as ArrayBuffer);
    response = { ok: true, zip: zip as Uint8Array<ArrayBuffer>, left };
  } catch (err) {
    response = { ok: false, message: String(err) };
  }
  self.postMessage(response, { transfer });
};
