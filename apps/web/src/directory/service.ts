// Keeps the directory synced through its personal space while this browser
// has a binding. The space's doc is the directory's own LoroDoc, which the
// directory store already saves and shares between tabs, so the session is
// told not to persist it again.
import { useSyncExternalStore } from "react";

import type { Identity } from "@/presence/identity";
import { loadIdentity, provisionalIdentity } from "@/presence/identity";
import { SpaceSession } from "@/space/space-session";

import {
  BINDING_KEY,
  clearBinding,
  loadBinding,
  saveBinding,
  sameBinding,
  type SpaceBinding,
} from "./binding";
import type { Directory } from "./directory";
import { directory } from "./store";

/** What the personal-space sync is up to, for screens that wait on it. */
export type DirectorySync = "off" | "syncing" | "synced" | "error";

let syncState: DirectorySync = "off";
const syncListeners = new Set<() => void>();

function setSyncState(next: DirectorySync): void {
  if (next === syncState) return;
  syncState = next;
  for (const listener of [...syncListeners]) listener();
}

function syncOf(session: SpaceSession): DirectorySync {
  const { phase, synced } = session.snapshot();
  if (phase.phase === "error" || phase.phase === "not-found") return "error";
  return synced ? "synced" : "syncing";
}

/** "synced" means the first pass with the server finished, not that it is idle. */
export function useDirectorySync(): DirectorySync {
  return useSyncExternalStore(
    (listener) => {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
    () => syncState,
    () => "off",
  );
}

/**
 * Resolves once the first pass with the server finished, or failed, or
 * `timeoutMs` ran out. For flows that need the projects listed before they
 * go on; the directory keeps syncing either way.
 */
export function waitForDirectorySync(
  timeoutMs: number,
): Promise<DirectorySync> {
  if (syncState === "synced" || syncState === "error")
    return Promise.resolve(syncState);
  return new Promise((resolve) => {
    const done = () => {
      if (syncState !== "synced" && syncState !== "error") return;
      finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      syncListeners.delete(done);
      resolve(syncState);
    }
    syncListeners.add(done);
  });
}

export class DirectoryService {
  private readonly dir: Directory;
  private readonly identity: () => Identity;
  private session: SpaceSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private bound: SpaceBinding | null = null;
  /** Set once the space proved to be something else; no restart then. */
  private refused: SpaceBinding | null = null;

  constructor(
    dir: Directory,
    identity: () => Identity = () => loadIdentity() ?? provisionalIdentity(),
  ) {
    this.dir = dir;
    this.identity = identity;
  }

  get running(): boolean {
    return this.session !== null;
  }

  /**
   * Brings the session in line with the stored binding: starts it, follows
   * a changed token, or stops when the binding is gone. Cheap to call.
   */
  refresh(): void {
    const binding = loadBinding();
    if (!binding) return this.stop();
    if (sameBinding(binding, this.refused)) return;
    if (this.session && this.bound) {
      if (binding.spaceId === this.bound.spaceId) {
        if (!sameBinding(binding, this.bound)) {
          this.bound = binding;
          this.session.setTarget(binding.token, binding.secret);
        }
        return;
      }
      this.stop();
    }
    this.begin(binding);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.stop();
    this.session = null;
    this.bound = null;
    setSyncState("off");
  }

  private begin(binding: SpaceBinding): void {
    // Referenced by onRefused, which only runs after construction.
    const session: SpaceSession = new SpaceSession({
      token: binding.token,
      linkKey: binding.secret,
      doc: this.dir.doc,
      identity: this.identity(),
      persist: false,
      // The local doc is marked as a directory from the start, so this only
      // catches a newer schema before uploading. A space of another kind is
      // caught after the merge (see onChange); what keeps the directory's
      // secrets out of one is that a binding only comes from this device or
      // the sealed pairing grant.
      accept: () => this.dir.unsupported() === null,
      onRefused: () => this.refuse(session),
      onRotated: (rotation, spaceId) => {
        if (spaceId !== this.bound?.spaceId) return;
        if (!rotation.canEdit) {
          console.warn("the directory space was rotated without an edit link");
          return;
        }
        const next = {
          spaceId,
          token: rotation.token,
          secret: rotation.link,
        };
        this.bound = next;
        saveBinding(next);
        // The old token is retired; without this the running socket keeps
        // knocking on it until the page reloads.
        session.setTarget(rotation.token, rotation.link);
      },
    });
    this.session = session;
    this.bound = binding;
    this.unsubscribe = session.subscribe(() => this.onChange(session));
    setSyncState("syncing");
    session.start();
  }

  private refuse(session: SpaceSession): void {
    if (session !== this.session) return;
    console.warn(
      "the space bound to the directory is not a directory",
      this.dir.unsupported(),
    );
    this.refused = this.bound;
    this.stop();
    setSyncState("error");
  }

  private onChange(session: SpaceSession): void {
    if (session !== this.session) return;
    const snap = session.snapshot();
    if (snap.phase.phase === "removed") {
      // The local doc stays useful on its own; only the sync is gone.
      clearBinding();
      this.stop();
      return;
    }
    setSyncState(syncOf(session));
    if (snap.phase.phase !== "opened" || !snap.synced) return;
    // Second line of defence behind `accept`, for a kind that only shows
    // up in the doc later.
    if (this.dir.unsupported()) this.refuse(session);
  }
}

let service: DirectoryService | null = null;
let creating: Promise<DirectoryService> | null = null;
let listening = false;

async function sharedService(): Promise<DirectoryService> {
  if (service) return service;
  creating ??= directory().then((dir) => (service = new DirectoryService(dir)));
  try {
    return await creating;
  } finally {
    creating = null;
  }
}

/**
 * Starts (or updates) the page's directory sync. Without a binding it opens
 * nothing, so a browser that never paired stays untouched. Also follows
 * bindings that other tabs create, rotate or clear.
 */
export async function refreshDirectoryService(): Promise<void> {
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("storage", (event) => {
      if (event.key === BINDING_KEY || event.key === null)
        void refreshDirectoryService().catch((error) =>
          console.warn("could not update the directory sync", error),
        );
    });
  }
  if (!service && !loadBinding()) return;
  (await sharedService()).refresh();
}

/** For tests, which share one module. */
export function stopDirectoryService(): void {
  service?.stop();
  service = null;
}
