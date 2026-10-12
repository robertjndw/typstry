import { LinkSecret } from "@/crypto/wasm";
import { directory } from "@/directory/store";
import { editSecret, token, viewSecret } from "@/directory/test-utils";
import { loadSpaceKey } from "@/space/space-links";

import { adoptProjectLink, parseProjectLink, projectUrl } from "./recent";

describe("project links", () => {
  afterEach(() => localStorage.clear());

  it("round-trips through a url", () => {
    const key = LinkSecret.generateEdit().toBase64url();
    const url = projectUrl(token(1), key, "https://t.test");
    expect(parseProjectLink(url)).toEqual({ token: token(1), key });
    expect(parseProjectLink("https://t.test/q/abc")).toBeNull();
  });

  it("adopting a link stores the key and lists the project", async () => {
    const key = editSecret(3);
    await adoptProjectLink(
      { token: token(3), key },
      { spaceId: "p3", permission: "write" },
      "Thesis",
    );
    expect(loadSpaceKey("p3")).toBe(key);
    expect((await directory()).list(Date.now())).toMatchObject([
      {
        projectId: "p3",
        title: "Thesis",
        link: { token: token(3), secret: key, edit: true },
      },
    ]);
  });

  it("never trades a stored edit secret for a view one", async () => {
    const edit = editSecret(4);
    await adoptProjectLink(
      { token: token(4), key: edit },
      { spaceId: "p4", permission: "write" },
      "T",
    );
    await adoptProjectLink(
      { token: token(5), key: viewSecret() },
      { spaceId: "p4", permission: "read" },
      "T",
    );
    expect(loadSpaceKey("p4")).toBe(edit);
    // Both links are known, and the edit one is the one that opens it.
    expect((await directory()).bestLink("p4", Date.now())?.token).toBe(
      token(4),
    );
  });
});
