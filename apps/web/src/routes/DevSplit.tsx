import { EphemeralStore, LoroDoc } from "loro-crdt";
import { useEffect, useState } from "react";

import { ProjectWorkspace } from "@/components/ProjectWorkspace";
import { initProject, ProjectDoc } from "@/doc/schema";
import { PALETTE } from "@/presence/identity";
import { PresenceProvider } from "@/presence/PresenceProvider";
import { ProjectProvider } from "@/project/ProjectProvider";

/**
 * Relays local updates between two docs like a server would, with a switch
 * to go offline. Offline updates are buffered and flushed in order on
 * reconnect, so both sides have to converge from concurrent histories.
 */
class MemorySync {
  private connected = true;
  private readonly buffers: [Uint8Array[], Uint8Array[]] = [[], []];
  private readonly docs: [ProjectDoc, ProjectDoc];
  private readonly onPending: (count: number) => void;

  constructor(docs: [ProjectDoc, ProjectDoc], onPending: (n: number) => void) {
    this.docs = docs;
    this.onPending = onPending;
  }

  attach(): () => void {
    const unsubscribes = ([0, 1] as const).map((from) =>
      this.docs[from].doc.subscribeLocalUpdates((bytes) => {
        const to = this.docs[1 - from]!;
        if (this.connected) {
          to.doc.import(bytes);
        } else {
          this.buffers[from].push(bytes);
          this.onPending(this.buffers[0].length + this.buffers[1].length);
        }
      }),
    );
    return () => unsubscribes.forEach((u) => u());
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) return;
    ([0, 1] as const).forEach((from) => {
      const buffer = this.buffers[from].splice(0);
      if (buffer.length > 0) this.docs[1 - from]!.doc.importBatch(buffer);
    });
    this.onPending(0);
  }
}

const IDENTITIES = [
  { name: "Peer A", color: PALETTE[5] },
  { name: "Peer B", color: PALETTE[0] },
] as const;

/** Presence is relayed unconditionally; the offline switch only covers docs. */
function linkEphemeral(a: EphemeralStore, b: EphemeralStore): () => void {
  const stopA = a.subscribeLocalUpdates((bytes) => b.apply(bytes));
  const stopB = b.subscribeLocalUpdates((bytes) => a.apply(bytes));
  return () => {
    stopA();
    stopB();
  };
}

function createPair(): [ProjectDoc, ProjectDoc] {
  const a = initProject(new LoroDoc(), { title: "Split view" });
  const b = new ProjectDoc(new LoroDoc());
  b.doc.import(a.doc.export({ mode: "snapshot" }));
  return [a, b];
}

/**
 * Dev-only: two independent docs synced in memory, to exercise convergence
 * (concurrent edits, clashes, deletes of open files) without a server.
 */
export function DevSplit() {
  const [[a, b]] = useState(createPair);
  const [connected, setConnected] = useState(true);
  const [pending, setPending] = useState(0);
  const [link] = useState(() => new MemorySync([a, b], setPending));
  const [[ephA, ephB]] = useState((): [EphemeralStore, EphemeralStore] => [
    new EphemeralStore(30_000),
    new EphemeralStore(30_000),
  ]);

  useEffect(() => link.attach(), [link]);
  useEffect(() => linkEphemeral(ephA, ephB), [ephA, ephB]);

  function toggle(next: boolean) {
    link.setConnected(next);
    setConnected(next);
  }

  const status = (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        checked={connected}
        onChange={(e) => toggle(e.target.checked)}
      />
      peer A connected
      {!connected && pending > 0 && <span>({pending} buffered)</span>}
    </label>
  );

  return (
    <div className="grid h-svh grid-cols-2 divide-x">
      <ProjectProvider doc={a}>
        <PresenceProvider ephemeral={ephA} identity={IDENTITIES[0]}>
          <ProjectWorkspace badge={status} />
        </PresenceProvider>
      </ProjectProvider>
      <ProjectProvider doc={b}>
        <PresenceProvider ephemeral={ephB} identity={IDENTITIES[1]}>
          <ProjectWorkspace badge={<span className="text-xs">peer B</span>} />
        </PresenceProvider>
      </ProjectProvider>
    </div>
  );
}
