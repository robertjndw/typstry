// Project links: building, parsing and adopting them. The list of projects a
// browser knows lives in the directory; keys and share lookups in
// space/space-links.ts.
import { isEditSecret, isProjectSecret } from "@/crypto/secret";
import { recordAdopted } from "@/directory/record";
import { loadSpaceKey, rememberShare, saveSpaceKey } from "@/space/space-links";
import type { ShareInfo } from "@/sync/api";

/**
 * The secret rides in the fragment, which browsers never send to the
 * server, so a share link carries everything needed to decrypt the project.
 * Edit links carry the edit secret, view links only the view secret.
 */
export function projectUrl(
  token: string,
  key: string,
  origin = window.location.origin,
) {
  return `${origin}/p/${encodeURIComponent(token)}#${key}`;
}

/** The share token and secret of a project link, or null for anything else. */
export function parseProjectLink(
  link: string,
): { token: string; key: string } | null {
  try {
    const url = new URL(link);
    const [, prefix, token] = url.pathname.split("/");
    const key = url.hash.slice(1);
    if (prefix !== "p" || !token || !isProjectSecret(key)) return null;
    return { token: decodeURIComponent(token), key };
  } catch {
    return null;
  }
}

/**
 * Stores a link this browser was handed for a project it may already know,
 * and lists the project in the directory.
 */
export async function adoptProjectLink(
  link: { token: string; key: string },
  share: ShareInfo,
  title: string,
): Promise<void> {
  const existing = loadSpaceKey(share.spaceId);
  // Never trade an edit secret this browser has for a view one.
  if (!existing || (isEditSecret(link.key) && !isEditSecret(existing)))
    saveSpaceKey(share.spaceId, link.key);
  rememberShare(link.token, share);
  await recordAdopted(
    share.spaceId,
    {
      token: link.token,
      secret: link.key,
      edit: share.permission === "write" && isEditSecret(link.key),
    },
    title,
  );
}
