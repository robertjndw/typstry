// Runs a folder link while a project is open: decides when to sync, runs one
// cycle at a time and saves the base afterwards. The cycle is in reconcile.ts.
import type { ProjectAssets } from "@/assets/project-assets";
import type { ProjectDoc } from "@/doc/schema";
import type { DocBackend } from "@/persist/local-doc-store";

import { trustedBase, type FolderBase, type FolderLink } from "./base";
import { handleFs, type FolderFs } from "./folder-fs";
import { FOLDER_ORIGIN } from "./origin";
import {
  isPermission,
  reconcile,
  type FirstLinkMode,
  type ReconcileReport,
} from "./reconcile";

export {
  preview,
  reconcile,
  type Conflict,
  type FirstLinkMode,
  type FirstLinkPreview,
  type ReconcileInput,
  type ReconcileReport,
  type ReconcileResult,
} from "./reconcile";

export type FolderSyncStatus =
  /** The browser wants the user to allow access again. */
  | "needs-permission"
  | "syncing"
  | "idle"
  /** The folder is gone (renamed, moved, deleted). */
  | "missing"
  | "error"
  /** Another tab of this browser syncs this project's folder. */
  | "other-tab"
  /** A first link waits for the project to arrive from the server. */
  | "waiting";

export interface FolderSyncState {
  status: FolderSyncStatus;
  error: string | null;
  report: ReconcileReport | null;
  lastSyncAt: number | null;
}

export type FolderLocker = (name: string) => Promise<(() => void) | null>;

export function defaultFolderLocker(): FolderLocker {
  return (name) => {
    if (typeof navigator === "undefined" || !navigator.locks) {
      // Without Web Locks the tabs cannot tell; better to sync than not.
      return Promise.resolve(() => {});
    }
    return new Promise((resolve) => {
      void navigator.locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        // Held until released: the promise the callback returns is the lock.
        return new Promise<void>((release) => resolve(() => release()));
      });
    });
  };
}

export interface FolderSyncOptions {
  spaceId: string;
  project: ProjectDoc;
  assets: ProjectAssets;
  canWrite: boolean;
  link: FolderLink;
  /** For tests; defaults to the link's handle. */
  fs?: FolderFs;
  backend: Pick<DocBackend, "saveFolder">;
  /** Writes the doc to this browser's store, without pushing it. */
  saveLocally: () => Promise<void>;
  synced: () => boolean;
  onState: (state: FolderSyncState) => void;
  lock?: FolderLocker;
  mode?: FirstLinkMode;
}

export const DOC_DEBOUNCE_MS = 800;
export const DOC_MAX_DELAY_MS = 3000;
const POLL_MS = 3000;
const POLL_WITH_OBSERVER_MS = 30_000;
const OBSERVER_DEBOUNCE_MS = 300;
/** How long a change we made ourselves is expected to echo back. */
const ECHO_MS = 2000;

function visible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

function errorName(e: unknown): string | null {
  return e instanceof DOMException ? e.name : null;
}

export class FolderSync {
  private readonly opts: FolderSyncOptions;
  private readonly fs: FolderFs;
  private readonly abort = new AbortController();
  private readonly lock: FolderLocker;
  private readonly recentlyWritten = new Map<string, number>();

  private link: FolderLink;
  private saved: string;
  private current: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private release: (() => void) | null = null;
  private state: FolderSyncState = {
    status: "idle",
    error: null,
    report: null,
    lastSyncAt: null,
  };

  private docTimer: ReturnType<typeof setTimeout> | null = null;
  private docDirtySince: number | null = null;
  private observerTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private teardown: (() => void)[] = [];

  constructor(opts: FolderSyncOptions) {
    this.opts = opts;
    this.fs = opts.fs ?? handleFs(opts.link.handle);
    this.lock = opts.lock ?? defaultFolderLocker();
    this.link = opts.link;
    this.saved = JSON.stringify(opts.link.base);
  }

  get snapshot(): FolderSyncState {
    return this.state;
  }

  start(): void {
    if (this.stopped || this.teardown.length > 0) return;
    const { project } = this.opts;

    const unsubscribe = project.doc.subscribe((batch) => {
      // Our own commit has nothing for the next cycle to do.
      if (batch.origin === FOLDER_ORIGIN) return;
      this.scheduleDoc();
    });
    this.teardown.push(unsubscribe);

    const poke = () => {
      if (visible()) void this.run();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("focus", poke);
      this.teardown.push(() => window.removeEventListener("focus", poke));
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", poke);
      this.teardown.push(() =>
        document.removeEventListener("visibilitychange", poke),
      );
    }

    let pollMs = POLL_MS;
    if (typeof FileSystemObserver !== "undefined") {
      try {
        const observer = new FileSystemObserver((records) =>
          this.onFolderChange(records),
        );
        void observer
          .observe(this.link.handle, { recursive: true })
          // Not supported for this folder: the poll keeps covering it.
          .catch(() => {});
        this.teardown.push(() => observer.disconnect());
        pollMs = POLL_WITH_OBSERVER_MS;
      } catch {
        // Fall back to polling.
      }
    }
    this.pollTimer = setInterval(poke, pollMs);

    void this.run();
  }

  /**
   * Stops every trigger and the cycle in flight and releases the lock. Resolves
   * once the cycle has settled, so a caller can remove the stored link without
   * the cycle writing it back.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.docTimer) clearTimeout(this.docTimer);
    if (this.observerTimer) clearTimeout(this.observerTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.docTimer = this.observerTimer = this.pollTimer = null;
    for (const undo of this.teardown.splice(0)) undo();
    await this.current;
    this.release?.();
    this.release = null;
  }

  syncNow(): Promise<void> {
    return this.run();
  }

  /** Call synchronously from a click: the browser only prompts then. */
  async reconnect(): Promise<void> {
    const asked = this.link.handle.requestPermission({ mode: "readwrite" });
    try {
      await asked;
    } catch {
      // The cycle reports it.
    }
    await this.run();
  }

  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current) {
      this.again = true;
      return this.current;
    }
    const loop = (async () => {
      try {
        do {
          this.again = false;
          await this.cycle();
        } while (this.again && !this.stopped);
      } finally {
        this.current = null;
      }
    })();
    this.current = loop;
    return loop;
  }

  private scheduleDoc(): void {
    if (this.stopped) return;
    const now = Date.now();
    this.docDirtySince ??= now;
    if (this.docTimer) clearTimeout(this.docTimer);
    const wait = Math.min(
      DOC_DEBOUNCE_MS,
      this.docDirtySince + DOC_MAX_DELAY_MS - now,
    );
    this.docTimer = setTimeout(
      () => {
        this.docTimer = null;
        this.docDirtySince = null;
        void this.run();
      },
      Math.max(0, wait),
    );
  }

  private onFolderChange(records: FileSystemChangeRecord[]): void {
    const now = Date.now();
    for (const [path, at] of this.recentlyWritten) {
      if (now - at > ECHO_MS) this.recentlyWritten.delete(path);
    }
    const foreign = records.some((record) => {
      if (record.type === "errored" || record.type === "unknown") return true;
      const path = record.relativePathComponents.join("/");
      return !this.recentlyWritten.has(path);
    });
    if (!foreign || this.stopped) return;
    if (this.observerTimer) clearTimeout(this.observerTimer);
    this.observerTimer = setTimeout(() => {
      this.observerTimer = null;
      void this.run();
    }, OBSERVER_DEBOUNCE_MS);
  }

  private set(patch: Partial<FolderSyncState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.state);
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    try {
      if (!this.release) {
        const release = await this.lock(`typstry:folder:${this.opts.spaceId}`);
        if (this.stopped) {
          release?.();
          return;
        }
        if (!release) {
          this.set({ status: "other-tab", error: null });
          return;
        }
        this.release = release;
      }

      const permission = await this.link.handle.queryPermission({
        mode: "readwrite",
      });
      if (this.stopped) return;
      if (permission !== "granted") {
        this.set({ status: "needs-permission", error: null });
        return;
      }

      const { project } = this.opts;
      const base = trustedBase(project.doc, this.link.base);
      // If the server's copy hasn't arrived yet, everything would look new.
      if (!base && !this.opts.synced()) {
        this.set({ status: "waiting", error: null });
        return;
      }

      // Not announced while idle, so the poll does not flicker the chip.
      if (this.state.status !== "idle") {
        this.set({ status: "syncing", error: null });
      }
      const result = await reconcile({
        project,
        fs: this.fs,
        assets: this.opts.assets,
        base,
        canWrite: this.opts.canWrite,
        signal: this.abort.signal,
        mode: this.opts.mode,
      });

      const at = Date.now();
      for (const path of [...result.report.written, ...result.report.deleted]) {
        this.recentlyWritten.set(path, at);
      }
      // Base first: the doc may hold changes only it accounts for, even if the
      // write-back was cut short.
      await this.save(result.base, result.report);
      if (result.interrupted) {
        this.set({ report: result.report });
        await this.fail(result.interrupted);
        return;
      }
      this.set({
        status: "idle",
        error: null,
        report: result.report,
        lastSyncAt: at,
      });
    } catch (e) {
      if (this.stopped) return;
      await this.fail(e);
    }
  }

  private async save(base: FolderBase, report: ReconcileReport): Promise<void> {
    const text = JSON.stringify(base);
    if (text === this.saved) return;
    // The doc must be stored before the base, so after a crash the base may
    // lag but never lead.
    if (report.applied?.changed) await this.opts.saveLocally();
    // In memory first: if storing fails, the next cycle must still start from
    // this base and not one the doc and folder have moved past.
    this.link = { ...this.link, base };
    await this.opts.backend.saveFolder(this.link);
    this.saved = text;
  }

  private async fail(e: unknown): Promise<void> {
    if (errorName(e) === "AbortError") return;
    if (isPermission(e)) {
      this.set({ status: "needs-permission", error: null });
      return;
    }
    if (errorName(e) === "NotFoundError") {
      // A file that vanished mid-cycle is not the folder being gone.
      try {
        await this.fs.readdir("");
      } catch (probe) {
        if (errorName(probe) === "NotFoundError") {
          this.set({ status: "missing", error: null });
          return;
        }
      }
    }
    this.set({
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
