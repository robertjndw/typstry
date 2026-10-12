// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { fetchServerInfo, isOutdated, PROTOCOL_VERSION } from "./protocol";

const WIRE = path.resolve(
  import.meta.dirname,
  "../../../../crates/typstry-wire/src/lib.rs",
);

describe("PROTOCOL_VERSION", () => {
  it("matches the Rust crates", () => {
    const source = readFileSync(WIRE, "utf8");
    const match = /^pub const PROTOCOL_VERSION: u32 = (\d+);$/m.exec(source);
    expect(match, "PROTOCOL_VERSION not found in typstry-wire").not.toBeNull();
    expect(PROTOCOL_VERSION).toBe(Number(match![1]));
  });
});

describe("fetchServerInfo", () => {
  const respond = (status: number, body: unknown) =>
    vi.fn<typeof fetch>(async () => Response.json(body, { status }));

  it("reads the versions", async () => {
    const fetch = respond(200, { protocol: 3, minProtocol: 2 });
    const info = await fetchServerInfo({ baseUrl: "http://x", fetch });
    expect(info).toEqual({ protocol: 3, minProtocol: 2 });
    expect(fetch.mock.calls[0]![0]).toBe("http://x/api/info");
    expect(isOutdated(info)).toBe(PROTOCOL_VERSION < 2);
    expect(isOutdated({ protocol: 9, minProtocol: PROTOCOL_VERSION + 1 })).toBe(
      true,
    );
    expect(isOutdated({ protocol: 9, minProtocol: PROTOCOL_VERSION })).toBe(
      false,
    );
  });

  it("never reads a failure as being outdated", async () => {
    const failures = [
      respond(404, {}),
      respond(200, { protocol: "1" }),
      vi.fn<typeof fetch>(() => Promise.reject(new TypeError("offline"))),
    ];
    for (const fetch of failures) {
      const info = await fetchServerInfo({ fetch });
      expect(info).toBeNull();
      expect(isOutdated(info)).toBe(false);
    }
  });
});
