import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { PairingCode } from "@/crypto/wasm";
import { MemoryBackend } from "@/persist/local-doc-store";
import { startEntering } from "@/pairing/start";
import { resetIdentityCache } from "@/presence/identity";
import { routes } from "@/router";

const shared = vi.hoisted(() => ({ backend: null as unknown }));

// Every component reaches storage through this, so one backend sees it all.
vi.mock("@/persist/local-doc-store", async (importActual) => ({
  ...(await importActual<typeof import("@/persist/local-doc-store")>()),
  defaultBackend: async () => shared.backend,
}));

afterEach(() => {
  localStorage.clear();
  resetIdentityCache();
});

describe("a browser only gets an identity when it needs one", () => {
  it("makes no device key or graph from browsing, dialogs or a cancelled pairing", async () => {
    const backend = new MemoryBackend();
    shared.backend = backend;
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    render(
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>,
    );

    fireEvent.keyDown(
      await screen.findByRole("button", { name: /^You are / }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Your devices…" }),
    );
    await screen.findByText(/Nothing to list yet/);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    fireEvent.keyDown(screen.getByRole("button", { name: /^You are / }), {
      key: "Enter",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Recovery key…" }),
    );
    await screen.findByRole("button", { name: "Create recovery key" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    // Starting a pairing as a new device and backing out.
    const sockets: { close: () => void }[] = [];
    const session = await startEntering(
      PairingCode.generate(42).toString(),
      "Laptop",
      {
        backend,
        createSocket: () => {
          const socket = { close: () => {}, send: () => {} };
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      },
    );
    session.close();

    await router.navigate("/recover");
    await screen.findByRole("heading", { name: /Recover with a recovery key/ });
    await waitFor(async () => {
      expect(await backend.loadDeviceKey()).toBeNull();
      expect(await backend.loadGraph()).toBeNull();
    });
  });
});
