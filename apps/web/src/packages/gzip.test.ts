// @vitest-environment node
import { gzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { PackageError } from "./errors";
import { gunzipLimited, gzipDeterministic } from "./gzip";

describe("gzip", () => {
  it("round trips", () => {
    const data = new TextEncoder().encode("hello ".repeat(1000));
    expect(gunzipLimited(gzipDeterministic(data), 1_000_000)).toEqual(data);
  });

  it("is deterministic and carries no timestamp", () => {
    const data = new TextEncoder().encode("same input");
    const a = gzipDeterministic(data);
    const b = gzipDeterministic(data);
    expect(a).toEqual(b);
    expect(a.subarray(4, 8)).toEqual(new Uint8Array(4));
  });

  it("stops a bomb at the cap", () => {
    const bomb = gzipSync(new Uint8Array(50 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => gunzipLimited(bomb, 1024 * 1024)).toThrow(
      /unpacks to more than 1 MB/,
    );
  });

  it("allows output exactly at the cap", () => {
    const data = new Uint8Array(1000);
    expect(gunzipLimited(gzipSync(data), 1000).length).toBe(1000);
    expect(() => gunzipLimited(gzipSync(data), 999)).toThrow(PackageError);
  });

  it("rejects input that is not gzip", () => {
    expect(() =>
      gunzipLimited(new TextEncoder().encode("PK zip"), 100),
    ).toThrow(/not a valid/);
  });
});
