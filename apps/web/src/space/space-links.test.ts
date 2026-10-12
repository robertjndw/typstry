import { afterEach, describe, expect, it } from "vitest";

import { newProject } from "@/crypto/test-utils";

import {
  forgetShare,
  forgetSpace,
  loadKeyring,
  loadShare,
  loadShareLinks,
  loadSpaceKey,
  rememberShare,
  saveKeyring,
  saveShareLinks,
  saveSpaceKey,
  storeRotation,
} from "./space-links";

const KEY = newProject().link.toBase64url();

describe("space links", () => {
  afterEach(() => localStorage.clear());

  it("keeps the key, keyring and share lookups apart per space", () => {
    saveSpaceKey("a", KEY, localStorage);
    saveKeyring("a", new Uint8Array([1, 2, 3]), localStorage);
    rememberShare("ta", { spaceId: "a", permission: "read" }, localStorage);

    expect(loadSpaceKey("a", localStorage)).toBe(KEY);
    expect(loadSpaceKey("b", localStorage)).toBeNull();
    expect(Array.from(loadKeyring("a", localStorage)!)).toEqual([1, 2, 3]);
    expect(loadShare("ta", localStorage)?.spaceId).toBe("a");
    forgetShare("ta", localStorage);
    expect(loadShare("ta", localStorage)).toBeNull();
  });

  it("keeps the storage keys of before the rename", () => {
    saveSpaceKey("a", KEY, localStorage);
    saveShareLinks("a", { editToken: "e", viewToken: "v" }, localStorage);
    saveKeyring("a", new Uint8Array([1]), localStorage);
    rememberShare("e", { spaceId: "a", permission: "write" }, localStorage);

    expect(localStorage.getItem("typstry:key:a")).not.toBeNull();
    expect(localStorage.getItem("typstry:links:a")).not.toBeNull();
    expect(localStorage.getItem("typstry:keyring:a")).not.toBeNull();
    expect(localStorage.getItem("typstry:share:e")).not.toBeNull();
  });

  it("forgets everything stored about one space", () => {
    for (const id of ["a", "b"]) {
      saveSpaceKey(id, KEY, localStorage);
      saveShareLinks(
        id,
        { editToken: `e${id}`, viewToken: `v${id}` },
        localStorage,
      );
      rememberShare(
        `e${id}`,
        { spaceId: id, permission: "write" },
        localStorage,
      );
    }
    forgetSpace("a", localStorage);

    expect(loadSpaceKey("a", localStorage)).toBeNull();
    expect(loadShareLinks("a", localStorage)).toBeNull();
    expect(loadShare("ea", localStorage)).toBeNull();
    expect(loadSpaceKey("b", localStorage)).toBe(KEY);
    expect(loadShare("eb", localStorage)).not.toBeNull();
  });

  it("stores the links of a rotation for an editor and for a viewer", () => {
    storeRotation(
      "a",
      { link: KEY, token: "e2", viewToken: "v2", canEdit: true },
      localStorage,
    );
    expect(loadSpaceKey("a", localStorage)).toBe(KEY);
    expect(loadShareLinks("a", localStorage)).toEqual({
      editToken: "e2",
      viewToken: "v2",
    });
    expect(loadShare("e2", localStorage)).toEqual({
      spaceId: "a",
      permission: "write",
      viewToken: "v2",
    });
    expect(loadShare("v2", localStorage)?.permission).toBe("read");

    storeRotation(
      "a",
      { link: KEY, token: "v3", viewToken: null, canEdit: false },
      localStorage,
    );
    expect(loadShareLinks("a", localStorage)).toBeNull();
    expect(loadShare("v3", localStorage)?.permission).toBe("read");
  });
});
