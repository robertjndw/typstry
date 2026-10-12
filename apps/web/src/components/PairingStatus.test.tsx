import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PairSession } from "@/pairing/session";

import { ApprovalDialog, PairingStatus } from "./PairingStatus";

describe("ApprovalDialog", () => {
  it("shows the joining device's fingerprint beside its name", () => {
    const session = { approve: vi.fn(), reject: vi.fn() };
    render(
      <ApprovalDialog
        session={session as unknown as PairSession}
        state={{
          status: "awaitingApproval",
          deviceName: "Work laptop",
          fingerprint: "AAAA-BBBB",
        }}
      />,
    );
    expect(
      screen.getByRole("dialog", { name: "Work laptop wants to join as you" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Fingerprint of the joining device"),
    ).toHaveTextContent("AAAA-BBBB");
    expect(
      screen.getByText(/shown on the device you are adding/),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(session.approve).toHaveBeenCalled();
  });
});

describe("PairingStatus", () => {
  it("shows a new device its own fingerprint while it waits", () => {
    render(
      <PairingStatus
        state={{ status: "verifying" }}
        holder={false}
        fingerprint="AAAA-BBBB"
        onRestart={() => {}}
      />,
    );
    expect(
      screen.getByLabelText("This device's fingerprint"),
    ).toHaveTextContent("AAAA-BBBB");
  });

  it("shows the holder no fingerprint of its own", () => {
    render(
      <PairingStatus
        state={{ status: "verifying" }}
        holder
        fingerprint="AAAA-BBBB"
        onRestart={() => {}}
      />,
    );
    expect(screen.queryByLabelText("This device's fingerprint")).toBeNull();
  });
});
