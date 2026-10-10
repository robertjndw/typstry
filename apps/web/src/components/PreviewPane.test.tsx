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

type WorkerDiagnostic = Extract<
  WorkerResponse,
  { type: "result" }
>["diagnostics"][number];

function diagnostic(
  severity: "error" | "warning",
  message: string,
): WorkerDiagnostic {
  return {
    path: "/main.typ",
    package: "",
    severity,
    message,
    range: { startLine: 0, startCol: 0, endLine: 0, endCol: 1 },
  };
}

let nextId = 1;
/** Emits a compile result and waits for the client's async render queue. */
async function compile(worker: FakeWorker, diagnostics: WorkerDiagnostic[]) {
  const id = nextId++;
  await act(async () => {
    worker.emit({ type: "ready" });
    worker.emit({ type: "compiling", id });
    worker.emit({
      type: "result",
      id,
      mainPath: "/main.typ",
      diagnostics,
      update: { action: "reset", data: new Uint8Array() },
      compileMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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
    expect(screen.getByRole("status")).toHaveTextContent("Failed");
    expect(
      screen.getByRole("button", { name: /Problems.*1 error/ }),
    ).toHaveAttribute("aria-expanded", "true");
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

  it("zooms with the keyboard while the viewport has focus", () => {
    setup();
    const level = screen.getByLabelText("Zoom level");
    const fit = level.textContent;
    const viewport = screen.getByTestId("preview-viewport");
    expect(viewport).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(viewport, { key: "=", ctrlKey: true });
    const zoomedIn = level.textContent;
    expect(zoomedIn).not.toBe(fit);
    fireEvent.keyDown(viewport, { key: "-", metaKey: true });
    fireEvent.keyDown(viewport, { key: "-", metaKey: true });
    expect(level.textContent).not.toBe(zoomedIn);

    // Plain keys are left alone for scrolling and typing.
    fireEvent.keyDown(viewport, { key: "0" });
    expect(screen.getByRole("button", { name: "Fit width" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.keyDown(viewport, { key: "0", ctrlKey: true });
    expect(level.textContent).toBe(fit);
    expect(screen.getByRole("button", { name: "Fit width" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("zooms on ctrl + wheel and blocks the browser zoom", () => {
    setup();
    const level = screen.getByLabelText("Zoom level");
    const before = level.textContent;
    const viewport = screen.getByTestId("preview-viewport");
    const plain = new WheelEvent("wheel", { deltaY: 40, cancelable: true });
    act(() => {
      viewport.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(false);
    expect(level.textContent).toBe(before);

    const pinch = new WheelEvent("wheel", {
      deltaY: -40,
      ctrlKey: true,
      cancelable: true,
    });
    act(() => {
      viewport.dispatchEvent(pinch);
    });
    expect(pinch.defaultPrevented).toBe(true);
    expect(level.textContent).not.toBe(before);
  });

  it("counts problems and collapses the panel", async () => {
    const { worker } = setup();
    await compile(worker, [
      diagnostic("error", "first error"),
      diagnostic("error", "second error"),
      diagnostic("warning", "a warning"),
    ]);
    const header = screen.getByRole("button", { name: /Problems/ });
    expect(header).toHaveTextContent("2 errors");
    expect(header).toHaveTextContent("1 warning");
    expect(screen.getByText("a warning")).toBeInTheDocument();

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("a warning")).not.toBeInTheDocument();

    // A changed but still nonzero error count keeps the manual collapse.
    await compile(worker, [diagnostic("error", "first error")]);
    expect(header).toHaveAttribute("aria-expanded", "false");

    // Errors coming back after a warnings only build reopen it.
    await compile(worker, [diagnostic("warning", "a warning")]);
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    await compile(worker, [diagnostic("error", "new error")]);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("new error")).toBeInTheDocument();

    await compile(worker, []);
    expect(screen.queryByLabelText("Diagnostics")).not.toBeInTheDocument();
  });
});
