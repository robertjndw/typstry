import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import type { ProjectAssets } from "@/assets/project-assets";
import { LinkFolderDialog } from "@/components/LinkFolderDialog";
import type { ProjectDoc } from "@/doc/schema";
import { defaultBackend } from "@/persist/local-doc-store";

import type { FolderLink } from "./base";
import { FolderSyncContext, type FolderSyncApi } from "./context";
import {
  FolderSync,
  preview as previewLink,
  type FirstLinkMode,
  type FirstLinkPreview,
  type FolderSyncState,
} from "./engine";
import { handleFs } from "./folder-fs";
import { folderSyncSupported, pickFolder } from "./support";

export interface FolderSyncProviderProps {
  spaceId: string;
  project: ProjectDoc;
  assets: ProjectAssets;
  canWrite: boolean;
  /** The doc has caught up with the server at least once. */
  synced: boolean;
  /** Writes the doc to this browser's store, without pushing it. */
  saveLocally: () => Promise<void>;
  children: ReactNode;
}

/** A folder that was picked but waits for the user to settle differences. */
interface Pending {
  handle: FileSystemDirectoryHandle;
  preview: FirstLinkPreview;
}

interface Active {
  link: FolderLink;
  mode: FirstLinkMode;
}

export function FolderSyncProvider(props: FolderSyncProviderProps) {
  // Decided once: the browser does not gain or lose the picker mid-page.
  const [supported] = useState(folderSyncSupported);
  if (!supported) return props.children;
  return <Provider {...props} />;
}

function Provider({
  spaceId,
  project,
  assets,
  canWrite,
  synced,
  saveLocally,
  children,
}: FolderSyncProviderProps) {
  // Undefined until the stored link is read, so the menu does not offer to
  // link a folder that is about to turn up.
  const [active, setActive] = useState<Active | null | undefined>(undefined);
  const [state, setState] = useState<FolderSyncState | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const engine = useRef<FolderSync | null>(null);
  // Settles once the previous engine has saved its base and given up the
  // lock. A restart (new assets after the links were replaced, a permission
  // change) has to wait for it and then read the base back from storage:
  // the link held in state still has the base from when it was linked.
  const stopping = useRef<Promise<void>>(Promise.resolve());
  // Read by the engine when it runs, so a change does not restart it.
  const live = useRef({ synced, saveLocally });
  useEffect(() => {
    live.current = { synced, saveLocally };
  }, [synced, saveLocally]);
  // A first link waits for the server's copy. Sync as soon as it arrives,
  // otherwise it sits there until the next poll, which is 30 s away when
  // there's a file system observer.
  useEffect(() => {
    if (synced) void engine.current?.syncNow();
  }, [synced]);

  useEffect(() => {
    let cancelled = false;
    void defaultBackend()
      .then((backend) => backend.loadFolder(spaceId))
      .then((link) => {
        if (!cancelled) setActive(link ? { link, mode: "folder-wins" } : null);
      })
      .catch((error) => {
        console.error(error);
        if (!cancelled) setActive(null);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let sync: FolderSync | null = null;
    void (async () => {
      await stopping.current;
      const backend = await defaultBackend();
      const stored = await backend.loadFolder(spaceId);
      if (cancelled) return;
      // Only the base is taken from storage; the handle in state is the
      // same folder. Nothing stored means the first save failed.
      const link = stored ? { ...active.link, base: stored.base } : active.link;
      sync = new FolderSync({
        spaceId,
        project,
        assets,
        canWrite,
        link,
        backend,
        // Only a link without a base has differences left to settle.
        mode: link.base ? "folder-wins" : active.mode,
        saveLocally: () => live.current.saveLocally(),
        synced: () => live.current.synced,
        onState: (next) => {
          if (!cancelled) setState(next);
        },
      });
      engine.current = sync;
      sync.start();
    })().catch((error: unknown) => {
      console.error(error);
      if (!cancelled) toast.error("Could not start syncing the folder");
    });
    return () => {
      cancelled = true;
      if (engine.current === sync) engine.current = null;
      if (sync) stopping.current = sync.stop();
      setState(null);
    };
  }, [active, spaceId, project, assets, canWrite]);

  const attach = useCallback(
    async (
      handle: FileSystemDirectoryHandle,
      mode: FirstLinkMode,
    ): Promise<void> => {
      const link: FolderLink = {
        spaceId,
        v: 1,
        handle,
        name: handle.name,
        base: null,
      };
      try {
        await (await defaultBackend()).saveFolder(link);
      } catch (error) {
        console.error(error);
        toast.error("Could not link the folder", {
          description: "This browser cannot store folder links.",
        });
        return;
      }
      setActive({ link, mode });
    },
    [spaceId],
  );

  const api = useMemo<FolderSyncApi | null>(() => {
    if (active === undefined) return null;
    return {
      state,
      linkName: active?.link.name ?? null,
      link: async () => {
        // First, before any await: the picker needs the click's activation.
        const picking = pickFolder();
        try {
          const handle = await picking;
          if (!handle || engine.current) return;
          const found = await previewLink({
            project,
            fs: handleFs(handle),
            assets,
          });
          if (found.differing.length === 0) {
            await attach(handle, "folder-wins");
            return;
          }
          setPending({ handle, preview: found });
        } catch (error) {
          console.error(error);
          toast.error("Could not open the folder");
        }
      },
      unlink: async () => {
        // The engine saves its base as cycles finish, so a cycle still
        // running would write the row back after it was removed.
        await engine.current?.stop();
        try {
          await (await defaultBackend()).removeFolder(spaceId);
        } catch (error) {
          console.error(error);
          toast.error("Could not unlink the folder");
          return;
        }
        setActive(null);
      },
      syncNow: async () => {
        await engine.current?.syncNow();
      },
      // Not async: the permission prompt must be requested inside the click.
      reconnect: () => engine.current?.reconnect() ?? Promise.resolve(),
    };
  }, [active, state, project, assets, spaceId, attach]);

  return (
    <FolderSyncContext.Provider value={api}>
      {children}
      <LinkFolderDialog
        preview={pending?.preview ?? null}
        folderName={pending?.handle.name ?? ""}
        onCancel={() => setPending(null)}
        onChoose={(mode) => {
          const picked = pending;
          setPending(null);
          if (picked) void attach(picked.handle, mode);
        }}
      />
    </FolderSyncContext.Provider>
  );
}
