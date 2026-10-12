import { editSecret, token } from "@/directory/test-utils";
import { LinkSecret, SpaceGroup, type PairingSpace } from "@/crypto/wasm";
import { localIdentity } from "@/mls/identity";
import type { DocBackend } from "@/persist/local-doc-store";
import { encodeProfile, provisionalIdentity } from "@/presence/identity";

/**
 * Stands in for `ensureSpace` as a holder with a personal space: the owner
 * secrets sit in the group record, where the real one leaves them.
 */
export async function fakeEnsureSpace({ backend }: { backend?: DocBackend }) {
  if (!backend) throw new Error("no backend");
  const { deviceSeed, graph } = await localIdentity(backend);
  const { group } = SpaceGroup.create(
    LinkSecret.generateEdit(),
    encodeProfile(provisionalIdentity()),
    deviceSeed,
    graph,
  );
  const ownerSecrets = group.ownerSecrets();
  await backend.saveMls("space-1", {
    state: null,
    device: null,
    removed: false,
    rotation: null,
    ownerSecrets,
  });
  return { spaceId: "space-1", token: token(9), secret: editSecret(9) };
}

/** A space a grant may carry. */
export async function someSpace(backend: DocBackend): Promise<PairingSpace> {
  const binding = await fakeEnsureSpace({ backend });
  const ownerSecrets = (await backend.loadMls(binding.spaceId))!.ownerSecrets!;
  return { token: binding.token, secret: binding.secret, ownerSecrets };
}
