import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { RosterMember } from "@/mls/members";
import type { MlsSession, MlsSnapshot } from "@/mls/session";

import { MembersSection } from "./MembersSection";

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
  };
}

function fakeSession(snapshot: Partial<MlsSnapshot>) {
  const full: MlsSnapshot = {
    phase: "active",
    members: [],
    canCommit: false,
    stalled: false,
    error: null,
    ...snapshot,
  };
  return {
    subscribe: () => () => {},
    getSnapshot: () => full,
    removeMembers: vi.fn(async () => {}),
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
  member(0, "Alice", "editor", true),
  member(1, "Bob", "editor"),
  member(2, "Carol", "viewer"),
];

describe("MembersSection", () => {
  it("lists members with their role and marks this device", () => {
    renderSection(fakeSession({ members: roster }));
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText("you")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Editor")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Viewer")).toBeInTheDocument();
  });

  it("offers no changes to a viewer", () => {
    renderSection(fakeSession({ members: roster, canCommit: false }));
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset links" })).toBeNull();
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

  it("stays out of the way when the group is not reachable", () => {
    const { container } = renderSection(fakeSession({ phase: "unavailable" }));
    expect(container).toBeEmptyDOMElement();
    const none = renderSection(null);
    expect(none.container).toBeEmptyDOMElement();
  });
});
