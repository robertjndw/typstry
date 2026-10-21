import { act, renderHook } from "@testing-library/react";

import { resetLineWrapping, useLineWrapping } from "./use-line-wrapping";

const KEY = "typstry:line-wrapping";

describe("useLineWrapping", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLineWrapping();
  });

  it("starts without wrapping", () => {
    const { result } = renderHook(() => useLineWrapping());
    expect(result.current[0]).toBe(false);
  });

  it("saves the choice and updates every component using it", () => {
    const a = renderHook(() => useLineWrapping());
    const b = renderHook(() => useLineWrapping());
    act(() => a.result.current[1](true));
    expect(b.result.current[0]).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("true");

    resetLineWrapping();
    expect(a.result.current[0]).toBe(true);
  });

  it("ignores stored values that are not a boolean", () => {
    localStorage.setItem(KEY, '"yes"');
    resetLineWrapping();
    const { result } = renderHook(() => useLineWrapping());
    expect(result.current[0]).toBe(false);
  });
});
