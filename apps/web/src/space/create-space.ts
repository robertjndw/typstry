import { LinkSecret, SpaceGroup, loadWasm } from "@/crypto/wasm";
import { createGroup, type DsClientOptions } from "@/mls/ds-client";
import { localIdentity } from "@/mls/identity";
import { defaultBackend, type DocBackend } from "@/persist/local-doc-store";
import {
  encodeProfile,
  loadIdentity,
  provisionalIdentity,
} from "@/presence/identity";
import { createSpace, type ApiOptions, type CreatedSpace } from "@/sync/api";

export interface CreatedGroup {
  created: CreatedSpace;
  /** Edit secret for the `#` part of the edit link. */
  key: string;
  link: LinkSecret;
  group: SpaceGroup;
  backend: DocBackend;
}

/**
 * Registers a space with the server and creates its member group, with this
 * device as the first member and its person as owner. What goes into the
 * space's doc is up to the caller: a project seeds one, the personal space
 * brings the directory it already has.
 */
export async function createSpaceGroup(
  opts: ApiOptions & {
    backend?: DocBackend;
    ds?: Pick<DsClientOptions, "url" | "createSocket" | "retry">;
  } = {},
): Promise<CreatedGroup> {
  await loadWasm();
  const created = await createSpace(opts);
  const link = LinkSecret.generateEdit();
  const key = link.toBase64url();
  const backend = opts.backend ?? (await defaultBackend());
  const identity = await localIdentity(backend);
  const { group, message } = SpaceGroup.create(
    link,
    encodeProfile(loadIdentity() ?? provisionalIdentity()),
    identity.deviceSeed,
    identity.graph,
  );
  // Kept before the server learns the public key: if the tab dies after the
  // init lands, this is the only copy of the secret that can ever rotate.
  await backend.saveMls(created.spaceId, {
    state: null,
    device: null,
    removed: false,
    rotation: null,
    ownerSecrets: group.ownerSecrets(),
  });
  await createGroup(created.editToken, message, opts.ds);
  // The group exists on the server now, and this device is its first
  // member. Keeping it is what lets the creator follow the group (and
  // remove people from it) instead of joining their own space as a
  // newcomer on the first visit.
  await backend.saveMls(created.spaceId, {
    state: group.exportState(),
    device: group.leafKeys().export(),
    removed: false,
    rotation: null,
    ownerPerson: group.ownerPerson(),
    ownerSecrets: group.ownerSecrets(),
  });
  return { created, key, link, group, backend };
}
