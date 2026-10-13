import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const flow = vi.hoisted(() => ({
  enterCode: vi.fn(async () => {}),
}));

vi.mock("@/pairing/usePairingFlow", () => ({
  usePairingFlow: () => ({
    session: null,
    state: null,
    code: null,
    holder: true,
    disposable: false,
    deviceName: "Laptop",
    setDeviceName: () => {},
    nameOk: true,
    busy: false,
    error: null,
    showCode: async () => {},
    enterCode: flow.enterCode,
    reset: () => {},
  }),
}));
vi.mock("@/components/PageShell", () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { Pair } from "./Pair";

describe("Pair", () => {
  beforeEach(() => flow.enterCode.mockClear());

  it("does not connect for a link until the user confirms", () => {
    render(
      <MemoryRouter initialEntries={["/pair#42-acorn-amber"]}>
        <Pair />
      </MemoryRouter>,
    );
    expect(flow.enterCode).not.toHaveBeenCalled();
    expect(
      screen.getByText(/add another device to your account/),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Connect to the other device" }),
    );
    expect(flow.enterCode).toHaveBeenCalledExactlyOnceWith("42-acorn-amber");
  });

  it("treats a link with a broken escape as one without a code", () => {
    render(
      <MemoryRouter initialEntries={["/pair#42-%E0%A4%A"]}>
        <Pair />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("button", { name: "Connect to the other device" }),
    ).toBeNull();
  });
});
