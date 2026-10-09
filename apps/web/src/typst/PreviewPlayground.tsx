// Dev-only manual test bed for the preview engine: a local ProjectDoc (no
// server), a plain textarea per file and the real PreviewPane. Lives at
// /dev/preview in dev builds.
import { LoroDoc, type TreeID } from "loro-crdt";
import { useEffect, useMemo, useState } from "react";

import { PreviewPane } from "@/components/PreviewPane";
import { createFile, getText, rename } from "@/doc/fs-ops";
import { buildPathIndex } from "@/doc/paths";
import { initProject, type ProjectDoc } from "@/doc/schema";

import { useCompilerClient } from "./hooks";

const MAIN = `#set page(paper: "a5")
= Hello

This line lives in main.typ.

#include "chapter.typ"
`;

const CHAPTER = `== Included chapter

Text from chapter.typ, pulled in with an include.
`;

function createPlaygroundProject(): ProjectDoc {
  const project = initProject(new LoroDoc(), { title: "Playground" });
  const main = project.mainFile!;
  const mainText = getText(project, main);
  mainText.delete(0, mainText.length);
  mainText.insert(0, MAIN);
  const chapter = createFile(project, null, "chapter.typ", "text");
  getText(project, chapter).insert(0, CHAPTER);
  project.doc.commit();
  return project;
}

/** Applies `next` to the LoroText as a single splice around the change. */
function applyEdit(project: ProjectDoc, id: TreeID, next: string): void {
  const text = getText(project, id);
  const prev = text.toString();
  let start = 0;
  while (
    start < prev.length &&
    start < next.length &&
    prev[start] === next[start]
  )
    start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev[endPrev - 1] === next[endNext - 1]
  ) {
    endPrev--;
    endNext--;
  }
  if (endPrev > start) text.delete(start, endPrev - start);
  if (endNext > start) text.insert(start, next.slice(start, endNext));
  project.doc.commit();
}

function useFiles(project: ProjectDoc) {
  const [version, setVersion] = useState(0);
  useEffect(
    () => project.doc.subscribe(() => setVersion((v) => v + 1)),
    [project],
  );
  return useMemo(() => {
    void version;
    const index = buildPathIndex(project);
    return [...index.byId]
      .filter(([, e]) => e.kind === "text")
      .map(([id, e]) => ({
        id,
        path: e.path,
        text: getText(project, id).toString(),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [project, version]);
}

export function PreviewPlayground() {
  const [project] = useState(createPlaygroundProject);
  const client = useCompilerClient(project);
  const files = useFiles(project);
  const [selected, setSelected] = useState<TreeID>(() => project.mainFile!);
  const file = files.find((f) => f.id === selected) ?? files[0];

  // Exposed for scripted browser checks (latency measurements).
  useEffect(() => {
    const byPath = (path: string) => buildPathIndex(project).byPath.get(path);
    (window as unknown as Record<string, unknown>).__typstry = {
      project,
      client,
      applyEdit: (path: string, text: string) => {
        const id = byPath(path);
        if (id) applyEdit(project, id, text);
      },
      rename: (path: string, name: string) => {
        const id = byPath(path);
        if (id) rename(project, id, name);
      },
    };
  }, [project, client]);

  return (
    <div className="grid h-svh grid-cols-2">
      <div className="flex min-h-0 flex-col border-r">
        <div className="flex gap-1 border-b p-2">
          {files.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`rounded px-2 py-1 text-xs ${f.id === file?.id ? "bg-muted font-semibold" : ""}`}
              onClick={() => setSelected(f.id)}
            >
              {f.path}
            </button>
          ))}
        </div>
        {file && (
          <textarea
            aria-label={`Source of ${file.path}`}
            className="min-h-0 flex-1 resize-none p-3 font-mono text-sm outline-none"
            value={file.text}
            spellCheck={false}
            onChange={(e) => applyEdit(project, file.id, e.target.value)}
          />
        )}
      </div>
      <PreviewPane
        client={client}
        onDiagnosticClick={(d) => {
          const target = files.find((f) => f.path === d.path);
          if (target) setSelected(target.id);
        }}
      />
    </div>
  );
}
