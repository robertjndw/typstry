import type { DsClientOptions } from "@/mls/ds-client";
import { defaultLocker } from "@/mls/session";
import type { DocBackend } from "@/persist/local-doc-store";
import { createSpaceGroup } from "@/space/create-space";
import { rememberCreatedSpace } from "@/space/space-links";
import type { ApiOptions } from "@/sync/api";

import { loadBinding, saveBinding, type SpaceBinding } from "./binding";

const LOCK = "typstry:space:create";

/**
 * The space that syncs this browser's directory, made on first use. Only
 * the moments that need it ask: pairing as the holder so far. The doc of the
 * space is the directory that already exists here, not a seeded one, and its
 * history uploads when the space is first connected.
 */
export async function ensureSpace(
  opts: ApiOptions & {
    backend?: DocBackend;
    ds?: Pick<DsClientOptions, "url" | "createSocket" | "retry">;
  } = {},
): Promise<SpaceBinding> {
  const known = loadBinding();
  if (known) return known;
  return defaultLocker()(LOCK, async () => {
    // Another tab may have made it while this one waited for the lock.
    const raced = loadBinding();
    if (raced) return raced;
    const { created, key } = await createSpaceGroup(opts);
    const binding = {
      spaceId: created.spaceId,
      token: created.editToken,
      secret: key,
    };
    rememberCreatedSpace(created, key);
    saveBinding(binding);
    return binding;
  });
}
