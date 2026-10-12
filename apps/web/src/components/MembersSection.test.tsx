import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { toast } from "sonner";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { RosterMember } from "@/mls/members";
import { NO_OWNER_KEY, type MlsSession, type MlsSnapshot } from "@/mls/session";

import { MembersSection } from "./MembersSection";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function member(
  leaf: number,
  name: string,
  role: RosterMember["role"],
  isSelf = false,
): RosterMember {
  return {
    leaf,
    role,
    name,
    color: "#1d4ed8",
    isSelf,
    signer: `s${leaf}`,
    anonymous: false,
    person: null,
    personState: "anonymous",
    personFingerprint: null,
    deviceRevoked: false,
    personProfile: null,
  };
}

function fakeSession(snapshot: Partial<MlsSnapshot>) {
  const full: MlsSnapshot = {
    phase: "active",
    members: [],
    canCommit: false,
    holdsOwnerKey: true,
    stalled: false,
    error: null,
    ...snapshot,
  };
  return {
    subscribe: () => () => {},
    getSnapshot: () => full,
    removeMembers: vi.fn(async () => {}),
    removePerson: vi.fn(async () => {}),
    resetLinks: vi.fn(async () => {}),
  };
}

function renderSection(session: ReturnType<typeof fakeSession> | null) {
  return render(
    <TooltipProvider>
      <MembersSection mls={session as unknown as MlsSession | null} />
    </TooltipProvider>,
  );
}

const roster = [
  member(0, "Alice", "owner", true),
  member(1, "Bob", "editor"),
  member(2, "Carol", "viewer"),
];

describe("MembersSection", () => {
  it("lists members with their role and marks this device", () => {
    renderSection(fakeSession({ members: roster }));
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("you")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Owner")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Editor")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Viewer")).toBeInTheDocument();
  });

  it("offers no changes to a viewer", () => {
    renderSection(fakeSession({ members: roster, canCommit: false }));
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset links" })).toBeNull();
  });

  it("tells an editor that only the owner can remove members", () => {
    const asBob = [
      member(0, "Alice", "owner"),
      member(1, "Bob", "editor", true),
      member(2, "Carol", "viewer"),
    ];
    renderSection(fakeSession({ members: asBob, canCommit: true }));
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset links" })).toBeNull();
    expect(
      screen.getByText("Only the owner can remove members."),
    ).toBeInTheDocument();
  });

  it("asks before removing, and says the links change", async () => {
    const session = fakeSession({ members: roster, canCommit: true });
    renderSection(session);
    // Not for yourself.
    expect(screen.queryByRole("button", { name: "Remove Alice" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove Carol" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Carol?" });
    expect(dialog).toHaveTextContent("links change");
    expect(session.removeMembers).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(session.removeMembers).toHaveBeenCalledWith(["s2"]),
    );
  });

  it("shows a person's devices as one row and removes them together", async () => {
    const device = (leaf: number, isSelf = false): RosterMember => ({
      ...member(leaf, "Bob", "editor", isSelf),
      person: "bb",
      personState: "verified",
      personFingerprint: "AAAA-BBBB",
    });
    const session = fakeSession({
      members: [member(0, "Alice", "owner", true), device(1), device(2)],
      canCommit: true,
    });
    renderSection(session);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[1]!).getByText("2 devices")).toBeInTheDocument();
    expect(within(items[1]!).getByText("AAAA-BBBB")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Bob" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Bob?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(session.removePerson).toHaveBeenCalledWith("bb"),
    );
    expect(session.removeMembers).not.toHaveBeenCalled();
  });

  it("heads a person with the profile their devices share", () => {
    renderSection(
      fakeSession({
        members: [
          member(0, "Alice", "owner", true),
          {
            ...member(1, "Old leaf name", "editor"),
            person: "bb",
            personState: "verified",
            personProfile: { name: "Bobby", color: "#1d4ed8" },
          },
        ],
      }),
    );
    expect(screen.getByText("Bobby")).toBeInTheDocument();
    expect(screen.queryByText("Old leaf name")).toBeNull();
  });

  it("shows a revoked device that is still in the group", () => {
    renderSection(
      fakeSession({
        members: [
          member(0, "Alice", "owner", true),
          {
            ...member(1, "Bob", "editor"),
            person: "bb",
            personState: "verified",
            deviceRevoked: true,
          },
        ],
      }),
    );
    expect(screen.getByText("Revoked device")).toBeInTheDocument();
  });

  it("flags a device whose identity does not check out", () => {
    renderSection(
      fakeSession({
        members: [
          member(0, "Alice", "editor", true),
          { ...member(1, "Eve", "editor"), personState: "unverified" },
        ],
      }),
    );
    expect(screen.getByText("Unverified device")).toBeInTheDocument();
  });

  it("resets the links after confirming", async () => {
    const session = fakeSession({ members: roster, canCommit: true });
    renderSection(session);
    fireEvent.click(screen.getByRole("button", { name: "Reset links" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Reset the links?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset links" }),
    );
    await waitFor(() => expect(session.resetLinks).toHaveBeenCalled());
  });

  it("tells an owner device without the owner key where to get it", () => {
    renderSection(
      fakeSession({ members: roster, canCommit: true, holdsOwnerKey: false }),
    );
    expect(screen.getByRole("button", { name: "Remove Carol" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset links" })).toBeDisabled();
    expect(
      screen.getByText(/does not have the project's owner key yet/),
    ).toBeInTheDocument();
  });

  it("explains a removal refused for want of the owner key", async () => {
    const session = fakeSession({ members: roster, canCommit: true });
    session.resetLinks.mockRejectedValueOnce(
      Object.assign(new Error("no owner key"), { kind: "NoOwnerKey" }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    renderSection(session);
    fireEvent.click(screen.getByRole("button", { name: "Reset links" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Reset the links?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset links" }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(NO_OWNER_KEY));
    error.mockRestore();
  });

  it("stays out of the way when the group is not reachable", () => {
    const { container } = renderSection(fakeSession({ phase: "unavailable" }));
    expect(container).toBeEmptyDOMElement();
    const none = renderSection(null);
    expect(none.container).toBeEmptyDOMElement();
  });
});
