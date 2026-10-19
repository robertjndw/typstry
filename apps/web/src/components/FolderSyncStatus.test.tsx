import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FolderSyncContext, type FolderSyncApi } from "@/folder/context";
import type { FolderSyncState, ReconcileReport } from "@/folder/engine";

import { FolderSyncNotice, FolderSyncStatus } from "./FolderSyncStatus";

function report(over: Partial<ReconcileReport> = {}): ReconcileReport {
  return {
    conflicts: [],
    skipped: [],
    warnings: [],
    written: [],
    deleted: [],
    merged: [],
    applied: null,
    heldLocal: [],
    ...over,
  };
}

function state(
  status: FolderSyncState["status"],
  over: Partial<FolderSyncState> = {},
): FolderSyncState {
  return { status, error: null, report: null, lastSyncAt: null, ...over };
}

function api(over: Partial<FolderSyncApi> = {}): FolderSyncApi {
  return {
    state: state("idle"),
    linkName: "thesis",
    link: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    ...over,
  };
}

function ui(value: FolderSyncApi | null) {
  return (
    <TooltipProvider>
      <FolderSyncContext.Provider value={value}>
        <FolderSyncStatus />
        <FolderSyncNotice />
      </FolderSyncContext.Provider>
      <Toaster />
    </TooltipProvider>
  );
}

// Radix opens the menu on pointer down or on the keyboard, not on click.
function openMenu(name: string | RegExp) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
}

const item = (name: string | RegExp) =>
  screen.queryByRole("menuitem", { name });

describe("FolderSyncStatus", () => {
  it("is the plain label where folders cannot be linked", () => {
    render(ui(null));
    expect(screen.getByText("Files")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers to link while no folder is linked", () => {
    const folder = api({ linkName: null, state: null });
    render(ui(folder));
    openMenu("Files menu");
    fireEvent.click(item("Link to local folder…")!);

    expect(folder.link).toHaveBeenCalledTimes(1);
    expect(item("Sync folder now")).toBeNull();
    expect(item(/^Unlink/)).toBeNull();
  });

  it("names the folder while it is in sync", () => {
    render(ui(api()));
    expect(screen.getByText("thesis")).toBeTruthy();
  });

  it("is not a status region, which belongs to the connection", () => {
    render(ui(api()));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers sync and unlink for a linked folder", () => {
    const folder = api();
    render(ui(folder));
    openMenu(/^Folder thesis/);

    expect(item("Link to local folder…")).toBeNull();
    expect(item("Reconnect folder")).toBeNull();
    fireEvent.click(item("Sync folder now")!);
    expect(folder.syncNow).toHaveBeenCalledTimes(1);
  });

  it("unlinks by name", () => {
    const folder = api();
    render(ui(folder));
    openMenu(/^Folder thesis/);
    fireEvent.click(item("Unlink thesis")!);
    expect(folder.unlink).toHaveBeenCalledTimes(1);
  });

  it("asks to reconnect straight from the click", () => {
    const folder = api({ state: state("needs-permission") });
    render(ui(folder));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(folder.reconnect).toHaveBeenCalledTimes(1);

    openMenu(/^Folder thesis/);
    fireEvent.click(item("Reconnect folder")!);
    expect(folder.reconnect).toHaveBeenCalledTimes(2);
  });

  it("says when the folder is missing or failing", () => {
    const folder = api({ state: state("missing") });
    const { rerender } = render(ui(folder));
    expect(
      screen.getByText("thesis was moved, renamed or deleted."),
    ).toBeTruthy();
    // Retrying cannot find a moved folder, so the way out is to unlink.
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(folder.unlink).toHaveBeenCalledTimes(1);

    rerender(ui(api({ ...folder, state: state("error", { error: "boom" }) })));
    expect(screen.getByText("Sync failed: boom")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(folder.syncNow).toHaveBeenCalledTimes(1);
  });

  it("shows no notice while the sync is quiet", () => {
    render(ui(api({ state: state("syncing") })));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  it("lists conflicts, warns once and clears them on dismiss", async () => {
    const conflict = { path: "main.typ", reason: "edited on both sides" };
    const first = state("idle", {
      report: report({ conflicts: [conflict], warnings: ["w", "w"] }),
    });
    const { rerender } = render(ui(api({ state: first })));
    expect(
      await screen.findByText("1 conflict while syncing the folder"),
    ).toBeTruthy();

    // The same conflict in the next cycle is not announced again.
    rerender(
      ui(
        api({
          state: state("idle", {
            report: report({ conflicts: [conflict], warnings: ["w"] }),
          }),
        }),
      ),
    );
    expect(
      screen.getAllByText("1 conflict while syncing the folder"),
    ).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: /issues? with the folder sync/ }),
    );
    const popover = screen.getByRole("dialog");
    expect(within(popover).getByText("main.typ")).toBeTruthy();
    expect(within(popover).getByText("edited on both sides")).toBeTruthy();
    // Warnings are listed once however often they repeat.
    expect(within(popover).getAllByText("w")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    // Warnings are not the user's to dismiss; they go when the cause does.
    expect(screen.queryByText("edited on both sides")).toBeNull();
    expect(screen.getByText("Warnings")).toBeTruthy();
  });
});
