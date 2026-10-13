import { relayApiPath, relayWsPath } from "@/crypto/wasm";
import { apiFetchRetrying, ApiError } from "@/sync/api";
import { socketUrl } from "@/sync/protocol";

export interface AllocatedChannel {
  channel: number;
  /** Opens the first seat; only the device showing the code has it. */
  claim: string;
  /** Seconds until the server drops the channel. */
  expiresIn: number;
}

/** Needs the wasm loaded, like everything about pairing. */
export async function allocateChannel(
  opts: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<AllocatedChannel> {
  const res = await apiFetchRetrying(`${opts.baseUrl ?? ""}${relayApiPath()}`, {
    method: "POST",
    signal: opts.signal,
  });
  if (!res.ok)
    throw new ApiError(res.status, `opening a channel failed: ${res.status}`);
  return (await res.json()) as AllocatedChannel;
}

/** `claim` only for the device that allocated the channel. */
export function relaySocketUrl(
  loc: Pick<Location, "protocol" | "host">,
  channel: number,
  claim?: string,
): string {
  let url = `${socketUrl(loc, relayWsPath())}&channel=${channel}`;
  if (claim) url += `&claim=${encodeURIComponent(claim)}`;
  return url;
}
