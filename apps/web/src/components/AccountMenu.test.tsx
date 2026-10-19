import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { loadIdentity, resetIdentityCache } from "@/presence/identity";

import { AccountMenu } from "./AccountMenu";

// The real dialog starts a pairing session, which needs the relay.
vi.mock("@/components/AddDeviceDialog", () => ({
  AddDeviceDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Add a device" /> : null,
}));

const identity = { name: "Ada", color: "#1d4ed8" };

afterEach(() => {
  localStorage.clear();
  resetIdentityCache();
});

function openMenu() {
  render(
    <MemoryRouter>
      <TooltipProvider>
        <AccountMenu identity={identity} />
      </TooltipProvider>
    </MemoryRouter>,
  );
  const trigger = screen.getByRole("button", {
    name: "You are Ada. Open the account menu",
  });
  // Radix opens the menu on pointer down or on the keyboard, not on click.
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("AccountMenu", () => {
  it("opens the name dialog and stores the new name", () => {
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Name and color…" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
      target: { value: "Grace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(loadIdentity()?.name).toBe("Grace");
  });

  it("opens the add-device dialog", async () => {
    openMenu();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The server-only entries load lazily.
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Add a device…" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Add a device" }),
    ).toBeTruthy();
  });

  it("asks for a name right away on the first visit", () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <AccountMenu identity={identity} firstVisit />
        </TooltipProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Join" })).toBeTruthy();
  });
});
