import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { newProject } from "@/crypto/test-utils";
import { LinkSecret } from "@/crypto/wasm";
import { projectUrl, saveProjectKey, saveShareLinks } from "@/project/recent";

import { ShareDialog } from "./ShareDialog";

afterEach(() => localStorage.clear());

describe("ShareDialog", () => {
  it("builds both links from the key the project rotated to, not the one the page opened with", () => {
    const before = newProject();
    const after = LinkSecret.generateEdit();
    // What a rotation keeps: the new key and the new tokens, together.
    saveProjectKey("p", after.toBase64url());
    saveShareLinks("p", { editToken: "edit-2", viewToken: "view-2" });

    render(
      <TooltipProvider>
        <ShareDialog
          projectId="p"
          token="edit-1"
          crypto={before.crypto}
          permission="write"
          viewToken="view-1"
          mls={null}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(screen.getByLabelText("Can edit")).toHaveValue(
      projectUrl("edit-2", after.toBase64url()),
    );
    expect(screen.getByLabelText("Can view")).toHaveValue(
      projectUrl("view-2", after.viewSecret()),
    );
  });
});
