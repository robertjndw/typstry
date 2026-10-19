import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { AccountMenu } from "./AccountMenu";

vi.mock("@/mode", () => ({ LOCAL_ONLY: true }));

describe("AccountMenu in local-only mode", () => {
  it("keeps the name and theme and drops everything that needs a server", () => {
    render(
      <MemoryRouter>
        <TooltipProvider>
          <AccountMenu identity={{ name: "Ada", color: "#000000" }} />
        </TooltipProvider>
      </MemoryRouter>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /account menu/ }), {
      key: "Enter",
    });
    expect(
      screen.getByRole("menuitem", { name: "Name and color…" }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /device/i })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /key/i })).toBeNull();
  });
});
