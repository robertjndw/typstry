import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { LoroDoc } from "loro-crdt";
import { createMemoryRouter, RouterProvider } from "react-router";

import { TooltipProvider } from "@/components/ui/tooltip";
import { generateEditSecret, importProjectKey } from "@/crypto/project-key";
import { initProject } from "@/doc/schema";
import { IDENTITY_KEY, resetIdentityCache } from "@/presence/identity";
import {
  loadProjectKey,
  rememberShare,
  saveProjectKey,
  saveShareLinks,
} from "@/project/recent";
import { routes } from "@/router";
import type { ConnectOptions } from "@/sync/connection";

const seed = initProject(new LoroDoc(), { title: "Server seeded" });
const KEY = generateEditSecret();
const VIEW_KEY = (await importProjectKey(KEY)).viewSecret;

const sync = vi.hoisted(() => ({
  connected: [] as ConnectOptions[],
  synced: true,
}));

// Stands in for the server: seeds the doc on join and reports it synced.
vi.mock("@/sync/connection", () => ({
  connectProject: (opts: ConnectOptions) => {
    sync.connected.push(opts);
    if (sync.synced) opts.doc.import(seed.doc.export({ mode: "snapshot" }));
    return {
      getStatus: () => "connected",
      subscribe: (l: (s: string) => void) => {
        l("connected");
        return () => {};
      },
      synced: sync.synced ? Promise.resolve() : new Promise(() => {}),
      close: () => {},
    };
  },
}));

function renderProject(
  permission: "write" | "read",
  { hash = `#${KEY}`, projectId = "proj1" } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ projectId, permission }, { status: 200 }),
    ),
  );
  const router = createMemoryRouter(routes, {
    initialEntries: [`/p/tok-current${hash}`],
  });
  return render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  );
}

describe("project route", () => {
  beforeEach(() => {
    resetIdentityCache();
    sync.connected.length = 0;
    sync.synced = true;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("opens the synced project and asks for a name on the first visit", async () => {
    renderProject("write");
    expect(await screen.findByText("Server seeded")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("textbox", { name: "Your name" });
    fireEvent.change(input, { target: { value: "Ada" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Join" }));
    expect(JSON.parse(localStorage.getItem(IDENTITY_KEY)!)).toMatchObject({
      name: "Ada",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "main.typ" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    for (const name of ["Files", "Editor", "Preview"]) {
      expect(screen.getByRole("region", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All projects" })).toHaveAttribute(
      "href",
      "/",
    );

    const [opts] = sync.connected;
    expect(opts).toMatchObject({ projectId: "proj1", canWrite: true });
    expect(opts!.key.editSecret).toBe(KEY);
  });

  it("asks for the full link when the key is missing", async () => {
    renderProject("write", { hash: "", projectId: "proj-unknown" });
    expect(
      await screen.findByText("This link is incomplete"),
    ).toBeInTheDocument();
    expect(sync.connected).toHaveLength(0);
  });

  it("opens offline from local data with a remembered key", async () => {
    localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({ name: "Ada", color: "#1d4ed8" }),
    );
    // A first, online visit stores the doc and remembers token and key.
    const first = renderProject("write", { projectId: "proj-offline" });
    await screen.findByText("Server seeded");
    first.unmount();
    await new Promise((r) => setTimeout(r, 50));

    // Now the server is unreachable and the link lacks the key.
    sync.synced = false;
    rememberShare("tok-current", {
      projectId: "proj-offline",
      permission: "write",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const router = createMemoryRouter(routes, {
      initialEntries: ["/p/tok-current"],
    });
    render(
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>,
    );
    expect(await screen.findByText("Server seeded")).toBeInTheDocument();
  });

  it("is read-only with a view link", async () => {
    localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({ name: "Viewer", color: "#1d4ed8" }),
    );
    renderProject("read", { hash: `#${VIEW_KEY}` });
    await screen.findByText("Server seeded");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New file" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: /share/i }));
    expect(screen.queryByLabelText("Can edit")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Can view")).toHaveValue(
      `${location.origin}/p/tok-current#${VIEW_KEY}`,
    );
    expect(sync.connected[0]).toMatchObject({ canWrite: false });
  });

  it("is read-only with an edit token but only the view secret", async () => {
    localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({ name: "Viewer", color: "#1d4ed8" }),
    );
    renderProject("write", { hash: `#${VIEW_KEY}` });
    await screen.findByText("Server seeded");
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(sync.connected[0]).toMatchObject({ canWrite: false });
    fireEvent.click(screen.getByRole("button", { name: /share/i }));
    expect(screen.queryByLabelText("Can edit")).not.toBeInTheDocument();
  });

  it("keeps the edit secret when the creator opens the view link", async () => {
    localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({ name: "Creator", color: "#1d4ed8" }),
    );
    saveProjectKey("proj1", KEY);
    renderProject("read", { hash: `#${VIEW_KEY}` });
    await screen.findByText("Server seeded");
    expect(loadProjectKey("proj1")).toBe(KEY);
  });

  it("shows both links to the creator", async () => {
    localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({ name: "Creator", color: "#1d4ed8" }),
    );
    saveShareLinks("proj1", {
      editToken: "tok-current",
      viewToken: "tok-view",
    });
    renderProject("write");
    await screen.findByText("Server seeded");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /share/i }));
    });
    expect(screen.getByLabelText("Can edit")).toHaveValue(
      `${location.origin}/p/tok-current#${KEY}`,
    );
    // Never the edit secret: that would hand viewers the signing key.
    expect(screen.getByLabelText("Can view")).toHaveValue(
      `${location.origin}/p/tok-view#${VIEW_KEY}`,
    );
  });
});
