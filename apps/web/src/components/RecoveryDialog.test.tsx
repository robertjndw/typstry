import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RecoveryDialog } from "./RecoveryDialog";

const WORDS = "one two three four";

describe("RecoveryDialog", () => {
  it("creates nothing until asked, then shows the words once", async () => {
    const create = vi.fn(async () => ({ words: WORDS }));
    const onOpenChange = vi.fn();
    render(<RecoveryDialog open onOpenChange={onOpenChange} create={create} />);
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Create recovery key" }),
    );
    expect(await screen.findByLabelText("Recovery words")).toHaveTextContent(
      WORDS,
    );

    // Cannot be dismissed before the words are confirmed stored.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();

    expect(screen.getByRole("status")).toHaveTextContent("up to date");
    fireEvent.click(screen.getByLabelText("I have stored it"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("says why creating failed", async () => {
    render(
      <RecoveryDialog
        open
        onOpenChange={() => {}}
        create={async () => {
          throw new Error("no room");
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create recovery key" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("no room"),
    );
  });
});
