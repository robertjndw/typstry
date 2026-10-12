// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mapConcurrent } from "./concurrent";

describe("mapConcurrent", () => {
  it("keeps the input order whatever order the calls finish in", async () => {
    const out = await mapConcurrent([30, 10, 20], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20"]);
  });

  it("never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    await mapConcurrent(Array.from({ length: 10 }), 3, async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
    });
    expect(peak).toBe(3);
  });

  it("rejects with the error of a failed call", async () => {
    await expect(
      mapConcurrent([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("two");
        return n;
      }),
    ).rejects.toThrow("two");
  });
});
