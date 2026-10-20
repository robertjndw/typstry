import { Text } from "@codemirror/state";

import { sourceRangeToOffsets } from "./lint";

describe("sourceRangeToOffsets", () => {
  it("counts columns in code points, not UTF-16 units", () => {
    const doc = Text.of(["a😀b", "second"]);
    expect(
      sourceRangeToOffsets(
        { startLine: 0, startCol: 2, endLine: 1, endCol: 3 },
        doc,
      ),
    ).toEqual({ from: 3, to: 8 });
  });

  it("clamps lines past the end to the document length", () => {
    const doc = Text.of(["ab"]);
    expect(
      sourceRangeToOffsets(
        { startLine: 5, startCol: 0, endLine: 6, endCol: 0 },
        doc,
      ),
    ).toEqual({ from: 2, to: 2 });
  });
});
