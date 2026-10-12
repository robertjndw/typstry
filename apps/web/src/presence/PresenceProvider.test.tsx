import { act, render } from "@testing-library/react";
import { EphemeralStore } from "loro-crdt";

import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { ProjectProvider } from "@/project/ProjectProvider";

import { PresenceProvider } from "./PresenceProvider";

const identity = { name: "Ada", color: "#be185d" };

/** Stands in for SpaceCrypto: grouped once the group's keys arrive. */
function keys() {
  const listeners = new Set<() => void>();
  return {
    grouped: false,
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    join() {
      this.grouped = true;
      for (const listener of listeners) listener();
    },
  };
}

function mount(crypto?: ReturnType<typeof keys>) {
  const project = initProject(newProject(1), { title: "Test" });
  const ephemeral = new EphemeralStore(30_000);
  render(
    <ProjectProvider doc={project}>
      <PresenceProvider
        ephemeral={ephemeral}
        identity={identity}
        crypto={crypto}
      >
        {null}
      </PresenceProvider>
    </ProjectProvider>,
  );
  return project;
}

describe("PresenceProvider", () => {
  it("writes the peer info only once records are signed with the leaf key", () => {
    const crypto = keys();
    const project = mount(crypto);
    const peer = project.doc.peerIdStr;
    expect(project.getPeer(peer)).toBeUndefined();

    act(() => crypto.join());
    expect(project.getPeer(peer)).toMatchObject(identity);
  });

  it("writes it right away without keys to wait for", () => {
    const project = mount();
    expect(project.getPeer(project.doc.peerIdStr)).toMatchObject(identity);
  });
});
