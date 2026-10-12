// Which space holds this browser's directory on the server. Absent until the
// person pairs a device or otherwise needs one; the directory then stays a
// plain local doc. The secret is the edit secret of the space, which every
// device of the person holds, so it never appears in a `/p/` URL.
import { isEditSecret } from "@/crypto/secret";
import { getStorage, readJson, removeKey, writeJson } from "@/lib/storage";

export const BINDING_KEY = "typstry:space";

export interface SpaceBinding {
  spaceId: string;
  /** The edit token. */
  token: string;
  /** The edit secret. */
  secret: string;
}

function parse(value: unknown): SpaceBinding | null {
  if (typeof value !== "object" || value === null) return null;
  const { spaceId, token, secret } = value as Partial<SpaceBinding>;
  if (
    typeof spaceId !== "string" ||
    !spaceId ||
    typeof token !== "string" ||
    !token ||
    typeof secret !== "string" ||
    !isEditSecret(secret)
  )
    return null;
  return { spaceId, token, secret };
}

export function loadBinding(
  storage: Storage | null = getStorage(),
): SpaceBinding | null {
  return parse(readJson(BINDING_KEY, storage));
}

export function saveBinding(
  binding: SpaceBinding,
  storage: Storage | null = getStorage(),
): void {
  writeJson(
    BINDING_KEY,
    {
      spaceId: binding.spaceId,
      token: binding.token,
      secret: binding.secret,
    },
    storage,
  );
}

export function clearBinding(storage: Storage | null = getStorage()): void {
  removeKey(BINDING_KEY, storage);
}

export function sameBinding(
  a: SpaceBinding | null,
  b: SpaceBinding | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.spaceId === b.spaceId && a.token === b.token && a.secret === b.secret
  );
}
