// @vitest-environment node
import { describe, expect, it } from "vitest";

import { downloadFilename } from "./download";

describe("downloadFilename", () => {
  it("joins parts and strips characters file systems reject", () => {
    expect(downloadFilename(["Thesis", "Oct 9, 2026, 10:04 PM"], "zip")).toBe(
      "Thesis - Oct 9, 2026, 10-04 PM.zip",
    );
    expect(downloadFilename(['a/b\\c:"d"'], "pdf")).toBe("a-b-c-d-.pdf");
  });

  it("falls back when nothing usable is left", () => {
    expect(downloadFilename(["", "  ", ".."], "zip")).toBe("project.zip");
  });
});
