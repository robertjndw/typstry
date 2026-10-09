import { act, fireEvent, render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { initProject } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { CompilerClient } from "@/typst/compiler-client";
import type { WorkerLike, WorkerResponse } from "@/typst/protocol";

import { PreviewPane } from "./PreviewPane";

class FakeWorker implements WorkerLike {
  private listeners = new Set<(e: MessageEvent<WorkerResponse>) => void>();
  postMessage() {}
  addEventListener(
    _type: "message",
    l: (e: MessageEvent<WorkerResponse>) => void,
  ) {
    this.listeners.add(l);
  }
  removeEventListener(
    _type: "message",
    l: (e: MessageEvent<WorkerResponse>) => void,
  ) {
    this.listeners.delete(l);
  }
  terminate() {}
  emit(message: WorkerResponse) {
    for (const l of this.listeners)
      l({ data: message } as MessageEvent<WorkerResponse>);
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 400"><defs class="glyph"></defs><g class="typst-page" data-tid="a" data-page-width="100" data-page-height="200"></g><g class="typst-page" data-tid="b" data-page-width="100" data-page-height="200"></g></svg>`;

function setup(onDiagnosticClick = vi.fn()) {
  const project = initProject(newProject(1), { title: "T" });
  const worker = new FakeWorker();
  const client = new CompilerClient(project, {
    worker,
    createRenderer: async () => ({
      apply: () => {},
      renderSvg: async () => svg,
      dispose: () => {},
    }),
  });
  render(
    <TooltipProvider>
      <PreviewPane client={client} onDiagnosticClick={onDiagnosticClick} />
    </TooltipProvider>,
  );
  return { worker, onDiagnosticClick };
}

describe("PreviewPane", () => {
  it("shows pages, compile time and diagnostics", async () => {
    const { worker, onDiagnosticClick } = setup();
    expect(screen.getByText("Loading the Typst compiler")).toBeInTheDocument();

    act(() => {
      worker.emit({ type: "ready" });
      worker.emit({ type: "compiling", id: 1 });
      worker.emit({
        type: "result",
        id: 1,
        mainPath: "/main.typ",
        diagnostics: [],
        update: { action: "reset", data: new Uint8Array() },
        compileMs: 12.4,
      });
    });
    expect(
      await screen.findByRole("img", { name: "Page 2" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("12 ms");

    act(() => {
      worker.emit({ type: "compiling", id: 2 });
      worker.emit({
        type: "result",
        id: 2,
        mainPath: "/main.typ",
        diagnostics: [
          {
            path: "/main.typ",
            package: "",
            severity: "error",
            message: "unknown variable: x",
            range: { startLine: 2, startCol: 4, endLine: 2, endCol: 5 },
          },
        ],
        compileMs: 3,
      });
    });
    const item = await screen.findByText("unknown variable: x");
    expect(screen.getByText("main.typ:3:5")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 error");
    // The last good render stays up.
    expect(screen.getAllByRole("img", { name: /^Page / })).toHaveLength(2);

    fireEvent.click(item);
    expect(onDiagnosticClick).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "main.typ",
        message: "unknown variable: x",
      }),
    );
  });

  it("zooms in and out from fit width", async () => {
    setup();
    const level = screen.getByLabelText("Zoom level");
    const before = level.textContent;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(level.textContent).not.toBe(before);
    expect(screen.getByRole("button", { name: "Fit width" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(level.textContent).toBe(before);
  });
});
