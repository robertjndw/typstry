import { keepOwnerKey } from "@/mls/session";
import type { DocBackend } from "@/persist/local-doc-store";
import { rememberShare, saveSpaceKey } from "@/space/space-links";
import type { ShareInfo } from "@/sync/api";

import { saveBinding } from "./binding";
import { refreshDirectoryService } from "./service";

/**
 * Makes `share` this browser's personal space, whether a pairing grant or a
 * recovery found it: the owner secrets go where the group's record keeps
 * them, the binding where the directory service looks, and the service
 * restarts on it.
 */
export async function adoptPersonalSpace(
  backend: Pick<DocBackend, "loadMls" | "saveMls">,
  space: {
    share: ShareInfo;
    token: string;
    secret: string;
    ownerSecrets: Uint8Array;
  },
): Promise<void> {
  const { spaceId } = space.share;
  await keepOwnerKey(backend, spaceId, space.ownerSecrets);
  saveSpaceKey(spaceId, space.secret);
  rememberShare(space.token, space.share);
  saveBinding({ spaceId, token: space.token, secret: space.secret });
  await refreshDirectoryService();
}
