import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadBinding, saveBinding } from "@/directory/binding";
import { editSecret, token } from "@/directory/test-utils";
import { DeviceKey } from "@/crypto/wasm";
import { localDeviceKey } from "@/mls/identity";
import { MemoryBackend } from "@/persist/local-doc-store";

import { applyGrant, holderGrant } from "./grant";
import { GrantRefusedError } from "./session";
import { fakeEnsureSpace } from "./test-utils";

const mocks = vi.hoisted(() => ({
  ensureSpace: vi.fn(),
  refresh: vi.fn(async () => {}),
}));
vi.mock("@/directory/ensure-space", () => ({
  ensureSpace: mocks.ensureSpace,
}));
vi.mock("@/directory/service", () => ({
  refreshDirectoryService: mocks.refresh,
}));

function device() {
  const key = DeviceKey.generate();
  const pub = key.publicKey();
  key.free();
  return { name: "Laptop", pub };
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mocks.ensureSpace.mockReset();
  mocks.refresh.mockClear();
});

/** A space the holder made: its owner secrets sit in the group record. */
async function holderWithSpace(backend: MemoryBackend) {
  const binding = await fakeEnsureSpace({ backend });
  mocks.ensureSpace.mockResolvedValue(binding);
  const ownerSecrets = (await backend.loadMls(binding.spaceId))!.ownerSecrets!;
  return { binding, ownerSecrets };
}

describe("holderGrant and the personal space", () => {
  it("hands over the binding with the owner secrets", async () => {
    const backend = new MemoryBackend();
    const { binding, ownerSecrets } = await holderWithSpace(backend);
    const grant = await holderGrant(backend, device());
    expect(grant.space).toEqual({
      token: binding.token,
      secret: binding.secret,
      ownerSecrets,
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("refuses, adding nothing, when the space cannot be made", async () => {
    mocks.ensureSpace.mockRejectedValue(new Error("offline"));
    const backend = new MemoryBackend();
    const pairing = device();
    await expect(holderGrant(backend, pairing)).rejects.toBeInstanceOf(
      GrantRefusedError,
    );
    expect(await backend.loadLabels()).toEqual({});
  });
});

describe("applyGrant and the personal space", () => {
  async function grantTo(backend: MemoryBackend) {
    const key = DeviceKey.import(await localDeviceKey(backend));
    const holder = new MemoryBackend();
    const made = await holderWithSpace(holder);
    const grant = await holderGrant(holder, {
      name: "x",
      pub: key.publicKey(),
    });
    key.free();
    return { grant, ...made };
  }

  it("keeps the owner secrets, saves the binding and starts the sync", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { spaceId: "space-1", permission: "write" },
          { status: 200 },
        ),
      ),
    );
    const backend = new MemoryBackend();
    const { grant, binding, ownerSecrets } = await grantTo(backend);
    await applyGrant(grant, backend, "Phone");

    expect(loadBinding()).toEqual(binding);
    expect((await backend.loadMls("space-1"))?.ownerSecrets).toEqual(
      ownerSecrets,
    );
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("pairs anyway when the space cannot be looked up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const backend = new MemoryBackend();
    const { grant } = await grantTo(backend);
    await applyGrant(grant, backend, "Phone");
    expect(loadBinding()).toBeNull();
    expect(await backend.loadGraph()).toEqual(grant.graph);
  });

  it("drops the binding of a person it gives up", async () => {
    saveBinding({ spaceId: "old", token: token(1), secret: editSecret(1) });
    const backend = new MemoryBackend();
    const { grant } = await grantTo(backend);
    // The device was never a person here, so only the replace flag matters.
    await applyGrant(grant, backend, "Phone", { replace: true });
    expect(loadBinding()).toBeNull();
  });
});
