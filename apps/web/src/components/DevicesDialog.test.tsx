import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toHex } from "@/crypto/bytes";
import { DeviceKey, PersonGraph } from "@/crypto/wasm";
import { localIdentity } from "@/mls/identity";
import type { ProjectRevoke } from "@/mls/revoke";
import { MemoryBackend } from "@/persist/local-doc-store";

import { DevicesDialog } from "./DevicesDialog";

const store = vi.hoisted(() => ({ backend: null as unknown }));
vi.mock("@/persist/local-doc-store", async (original) => ({
  ...(await original<typeof import("@/persist/local-doc-store")>()),
  defaultBackend: async () => store.backend,
}));

const key = () => DeviceKey.generate();

beforeEach(() => {
  store.backend = new MemoryBackend();
});

/** This browser plus a phone and a revoked tablet, the phone named. */
async function withDevices() {
  const backend = store.backend as MemoryBackend;
  const { deviceSeed, graph } = await localIdentity(backend);
  const phone = key().publicKey();
  const tablet = key();
  const next = PersonGraph.decode(graph);
  next.addDevice(deviceSeed, phone);
  next.addDevice(deviceSeed, tablet.publicKey());
  next.revoke(deviceSeed, tablet.publicKey());
  await backend.mergeGraph(next.encode(), (_, incoming) => incoming);
  await backend.saveLabels({ [toHex(phone)]: "Phone" });
  return { phone };
}

function open(
  revoke = vi.fn<(pub: Uint8Array) => Promise<ProjectRevoke[]>>(async () => []),
) {
  render(<DevicesDialog open onOpenChange={() => {}} revoke={revoke} />);
  return revoke;
}

describe("DevicesDialog", () => {
  it("lists the devices with names, this device and revoked ones", async () => {
    await withDevices();
    open();
    const list = await screen.findByRole("list", { name: "Devices" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText(/this device/)).toBeInTheDocument();
    expect(within(items[1]!).getByText("Phone")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Revoked")).toBeInTheDocument();
    // This device and the revoked one have nothing to revoke.
    expect(screen.getAllByRole("button", { name: /^Revoke / })).toHaveLength(1);
  });

  it("asks first, then revokes the device and reports the projects", async () => {
    const { phone } = await withDevices();
    const revoke = open(
      vi.fn(async (): Promise<ProjectRevoke[]> => [
        {
          projectId: "p1",
          title: "Thesis",
          result: { status: "cleaned", removed: 1 },
        },
        {
          projectId: "p2",
          title: "Notes",
          result: {
            status: "unreached",
            reason: "you can only view it",
          },
        },
      ]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke Phone" }),
    );
    expect(revoke).not.toHaveBeenCalled();

    const confirm = await screen.findByRole("dialog", {
      name: "Revoke Phone?",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(revoke).toHaveBeenCalledWith(phone));
    expect(await screen.findByText("Phone was revoked.")).toBeInTheDocument();
    expect(
      screen.getByText("Removed from 1 of 2 projects."),
    ).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText(/you can only view it/)).toBeInTheDocument();
  });

  it("does not make a person of a browser that has none", async () => {
    open();
    expect(await screen.findByText(/Nothing to list yet/)).toBeInTheDocument();
    expect(await (store.backend as MemoryBackend).loadGraph()).toBeNull();
  });
});
