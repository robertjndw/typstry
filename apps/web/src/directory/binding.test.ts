import { afterEach, describe, expect, it } from "vitest";

import {
  BINDING_KEY,
  clearBinding,
  loadBinding,
  sameBinding,
  saveBinding,
} from "./binding";
import { editSecret, token, viewSecret } from "./test-utils";

afterEach(() => localStorage.clear());

const binding = { spaceId: "space", token: token(1), secret: editSecret(1) };

describe("binding", () => {
  it("is absent until saved, and clears", () => {
    expect(loadBinding()).toBeNull();
    saveBinding(binding);
    expect(loadBinding()).toEqual(binding);
    clearBinding();
    expect(loadBinding()).toBeNull();
  });

  it("refuses junk and secrets that are not edit secrets", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...binding, spaceId: "" }),
      JSON.stringify({ ...binding, token: 3 }),
      JSON.stringify({ ...binding, secret: viewSecret(1) }),
      JSON.stringify({ ...binding, secret: "x" }),
    ]) {
      localStorage.setItem(BINDING_KEY, raw);
      expect(loadBinding()).toBeNull();
    }
  });

  it("compares by value", () => {
    expect(sameBinding(binding, { ...binding })).toBe(true);
    expect(sameBinding(binding, { ...binding, token: token(2) })).toBe(false);
    expect(sameBinding(null, null)).toBe(true);
    expect(sameBinding(binding, null)).toBe(false);
  });
});
