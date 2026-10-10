// The client/server protocol version, mirroring PROTOCOL_VERSION in
// crates/typstry-wire/src/lib.rs (protocol.test.ts keeps them in step). The
// server answers 426 to a client below its minimum, which for a page means
// a stale tab that has to reload to pick up the new build.

export const PROTOCOL_VERSION = 1;

export const PROTOCOL_HEADER = "X-Typstry-Protocol";

/** Query parameter on the WebSocket URL; browsers cannot set its headers. */
export const PROTOCOL_QUERY = "protocol";

export const RELOAD_MESSAGE =
  "A newer version of typstry is available. Reload the page.";

export function protocolHeaders(): Record<string, string> {
  return { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
}

export interface ServerInfo {
  protocol: number;
  minProtocol: number;
}

/**
 * Asks the server which protocol versions it serves. Null when it cannot
 * say (offline, an older server without the endpoint, a proxy's page), so
 * callers never mistake a network problem for being outdated.
 */
export async function fetchServerInfo(
  opts: { baseUrl?: string; fetch?: typeof fetch } = {},
): Promise<ServerInfo | null> {
  const fetchFn = opts.fetch ?? ((...args) => fetch(...args));
  try {
    const res = await fetchFn(`${opts.baseUrl ?? ""}/api/info`);
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<ServerInfo> | null;
    if (
      typeof body?.protocol !== "number" ||
      typeof body.minProtocol !== "number"
    )
      return null;
    return { protocol: body.protocol, minProtocol: body.minProtocol };
  } catch {
    return null;
  }
}

/** Whether a server with `info` refuses this build. */
export function isOutdated(info: ServerInfo | null): boolean {
  return info !== null && info.minProtocol > PROTOCOL_VERSION;
}
