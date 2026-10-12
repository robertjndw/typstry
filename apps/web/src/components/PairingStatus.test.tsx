import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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

const sync = vi.hoisted(() => ({ state: "syncing", entries: null as unknown }));
vi.mock("@/directory/service", () => ({ useDirectorySync: () => sync.state }));
vi.mock("@/directory/store", () => ({ useDirectory: () => sync.entries }));

describe("PairingStatus done", () => {
  const entry = (title: string | null, state = "listed") => ({
    projectId: title ?? "x",
    title,
    state,
    link: { token: `t-${title}`, secret: "key" },
  });
  const renderDone = (holder = false) =>
    render(
      <MemoryRouter>
        <PairingStatus
          state={{ status: "done" }}
          holder={holder}
          onRestart={() => {}}
        />
      </MemoryRouter>,
    );

  it("waits for the first sync before listing", () => {
    sync.state = "syncing";
    sync.entries = [];
    renderDone();
    expect(screen.getByText("Syncing your projects…")).toBeVisible();
    expect(screen.queryByText(/no projects yet/)).toBeNull();
  });

  it("lists the synced projects", () => {
    sync.state = "synced";
    sync.entries = [entry("Thesis"), entry("Old", "forgotten")];
    renderDone();
    expect(screen.getByRole("link", { name: "Thesis" })).toHaveAttribute(
      "href",
      "/p/t-Thesis#key",
    );
    expect(screen.queryByRole("link", { name: "Old" })).toBeNull();
  });

  it("says so when the other device has none", () => {
    sync.state = "synced";
    sync.entries = [];
    renderDone();
    expect(screen.getByText(/no projects yet/)).toBeVisible();
  });

  it("shows the holder no list", () => {
    sync.state = "synced";
    sync.entries = [entry("Thesis")];
    renderDone(true);
    expect(screen.queryByRole("link")).toBeNull();
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
