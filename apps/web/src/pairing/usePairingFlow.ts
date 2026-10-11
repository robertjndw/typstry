import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { fitDeviceName, loadWasm } from "@/crypto/wasm";
import { toError } from "@/lib/errors";
import { ApiError } from "@/sync/api";

import { defaultDeviceName } from "./device-name";
import type { PairSession, PairState } from "./session";
import { isHolder, startEntering, startShowing } from "./start";

const NO_SUBSCRIPTION = () => () => {};

/** The state of a session, or null while there is none. */
function usePairState(session: PairSession | null): PairState | null {
  return useSyncExternalStore(
    session ? session.subscribe : NO_SUBSCRIPTION,
    () => session?.state ?? null,
  );
}

/**
 * One pairing at a time for a page: showing a code or entering one, then
 * whatever comes of it. Unmounting abandons it.
 */
export function usePairingFlow() {
  const [session, setSession] = useState<PairSession | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [holder, setHolder] = useState<boolean | null>(null);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = usePairState(session);
  // Bumped by every start and by reset, so a start that finishes after it
  // was replaced closes its session instead of installing it.
  const generation = useRef(0);
  const current = useRef<PairSession | null>(null);

  const drop = useCallback(() => {
    generation.current++;
    current.current?.close();
    current.current = null;
    setSession(null);
    setCode(null);
    setBusy(false);
  }, []);

  useEffect(() => {
    let live = true;
    // The name checks run in the wasm, so nothing that asks for a name may
    // render before it is loaded; `holder` gates all of it.
    void Promise.all([isHolder(), loadWasm()]).then(
      ([is]) => live && setHolder(is),
      (e: unknown) => {
        console.error(e);
        if (live) setError(`Could not start pairing: ${toError(e).message}`);
      },
    );
    return () => {
      live = false;
      drop();
    };
  }, [drop]);

  const begin = useCallback(
    async (
      open: () => Promise<{ session: PairSession; code: string | null }>,
    ) => {
      drop();
      const mine = generation.current;
      setBusy(true);
      setError(null);
      try {
        const started = await open();
        if (mine !== generation.current) return started.session.close();
        current.current = started.session;
        setSession(started.session);
        setCode(started.code);
      } catch (e) {
        if (mine !== generation.current) return;
        console.error(e);
        const kind = (e as { kind?: string }).kind;
        setError(
          kind === "BadCode"
            ? "That is not a pairing code. It looks like 42-word-word."
            : e instanceof ApiError && e.status === 503
              ? "The server has no free channel right now. Try again in a moment."
              : `Could not start pairing: ${toError(e).message}`,
        );
      } finally {
        if (mine === generation.current) setBusy(false);
      }
    },
    [drop],
  );

  // Only a new device sends its name; the field is checked before either
  // start is offered to one, so the fallback is for a holder.
  const showCode = useCallback(
    () =>
      begin(() =>
        startShowing(fitDeviceName(deviceName) ?? defaultDeviceName()),
      ),
    [begin, deviceName],
  );
  const enterCode = useCallback(
    (input: string) =>
      begin(async () => ({
        session: await startEntering(
          input,
          fitDeviceName(deviceName) ?? defaultDeviceName(),
        ),
        code: null,
      })),
    [begin, deviceName],
  );
  const nameOk = holder !== null && fitDeviceName(deviceName) !== undefined;

  return {
    session,
    state,
    code,
    holder,
    deviceName,
    setDeviceName,
    nameOk,
    busy,
    error,
    showCode,
    enterCode,
    reset: drop,
  };
}
