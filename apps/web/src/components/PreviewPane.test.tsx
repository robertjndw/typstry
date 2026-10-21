import { act, fireEvent, render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { getText } from "@/doc/fs-ops";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { newProject } from "@/doc/test-utils";
import { IS_MAC } from "@/lib/platform";
import { CompilerClient } from "@/typst/compiler-client";
import type {
  RenderPayload,
  WorkerEvents,
  WorkerLike,
  WorkerRequest,
  WorkerResponse,
} from "@/typst/protocol";

import { PreviewPane, type PreviewScrollTarget } from "./PreviewPane";

const MOD = IS_MAC ? { metaKey: true } : { ctrlKey: true };

class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  private listeners = new Set<(e: MessageEvent<WorkerResponse>) => void>();
  postMessage(message: WorkerRequest) {
    this.sent.push(message);
  }
  addEventListener<K extends keyof WorkerEvents>(
    type: K,
    l: (e: WorkerEvents[K]) => void,
  ) {
    if (type === "message")
      this.listeners.add(l as (e: MessageEvent<WorkerResponse>) => void);
  }
  removeEventListener<K extends keyof WorkerEvents>(
    _type: K,
    l: (e: WorkerEvents[K]) => void,
  ) {
    this.listeners.delete(l as (e: MessageEvent<WorkerResponse>) => void);
  }
  terminate() {}
  emit(message: WorkerResponse) {
    for (const l of this.listeners)
      l({ data: message } as MessageEvent<WorkerResponse>);
  }
}

const fullRender: RenderPayload = {
  rootTag: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 400">',
  defs: '<defs class="glyph"></defs>',
  pages: ["a", "b"].map((tid) => ({
    tid,
    width: 100,
    height: 200,
    markup: `<g class="typst-page" data-tid="${tid}" data-page-width="100" data-page-height="200"></g>`,
  })),
};

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
/** Emits a compile result and lets the client build the document. */
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
      render: fullRender,
      compileMs: 1,
      renderMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setup(onDiagnosticClick = vi.fn()) {
  const project = initProject(newProject(1), { title: "T" });
  const worker = new FakeWorker();
  const client = new CompilerClient(project, {
    worker,
  });
  render(
    <TooltipProvider>
      <PreviewPane client={client} onDiagnosticClick={onDiagnosticClick} />
    </TooltipProvider>,
  );
  return { worker, project, onDiagnosticClick };
}

describe("PreviewPane", () => {
  it("offers a retry when the compiler could not start", async () => {
    const { worker } = setup();
    act(() => {
      worker.emit({ type: "initError", message: "TypeError: Failed to fetch" });
    });
    expect(
      screen.getByText(/Could not start the Typst compiler/),
    ).toBeInTheDocument();
    worker.sent = [];
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(worker.sent).toEqual([{ type: "restart" }]);
  });

  it("offers a restart while a compile runs long", () => {
    vi.useFakeTimers();
    try {
      const workers: FakeWorker[] = [];
      const client = new CompilerClient(
        initProject(newProject(1), { title: "T" }),
        {
          createWorker: () => {
            const w = new FakeWorker();
            workers.push(w);
            return w;
          },
        },
      );
      render(
        <TooltipProvider>
          <PreviewPane client={client} />
        </TooltipProvider>,
      );
      act(() => {
        workers[0]!.emit({ type: "ready" });
        workers[0]!.emit({ type: "compiling", id: 1 });
      });
      expect(screen.queryByText(/Still compiling/)).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(61_000));
      expect(screen.getByText(/Still compiling/)).toBeInTheDocument();
      expect(workers).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Restart" }));
      expect(workers).toHaveLength(2);
      expect(screen.queryByText(/Still compiling/)).not.toBeInTheDocument();
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

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
        render: fullRender,
        compileMs: 12.4,
        renderMs: 1,
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
        renderMs: 0,
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
    expect(screen.getByText("a warning").closest("[inert]")).not.toBeNull();

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

  it("starts a warnings only panel collapsed and respects the toggle", async () => {
    const { worker } = setup();
    await compile(worker, [diagnostic("warning", "a warning")]);
    const header = screen.getByRole("button", { name: /Problems/ });
    expect(header).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    // Other warnings do not undo what the user chose.
    await compile(worker, [
      diagnostic("warning", "a warning"),
      diagnostic("warning", "another"),
    ]);
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);

    // Errors open it.
    await compile(worker, [diagnostic("error", "broken")]);
    expect(header).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses again on its own once errors are fixed", async () => {
    const { worker } = setup();
    // The first compile of a project that opens with errors.
    await compile(worker, [
      diagnostic("error", "broken"),
      diagnostic("warning", "a warning"),
    ]);
    const header = screen.getByRole("button", { name: /Problems/ });
    expect(header).toHaveAttribute("aria-expanded", "true");

    await compile(worker, [diagnostic("warning", "a warning")]);
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  describe("status indicator", () => {
    it("shows the spinner only for compiles that run long", async () => {
      vi.useFakeTimers();
      try {
        const { worker } = setup();
        act(() => {
          worker.emit({ type: "ready" });
          worker.emit({ type: "compiling", id: 1 });
        });
        // The very first compile has no earlier result to show instead.
        expect(screen.getByRole("status")).toHaveTextContent("Compiling");
        act(() => {
          worker.emit({
            type: "result",
            id: 1,
            mainPath: "/main.typ",
            diagnostics: [],
            render: fullRender,
            compileMs: 12,
            renderMs: 1,
          });
        });
        expect(screen.getByRole("status")).toHaveTextContent("12 ms");

        act(() => {
          worker.emit({ type: "compiling", id: 2 });
        });
        act(() => vi.advanceTimersByTime(250));
        expect(screen.getByRole("status")).toHaveTextContent("12 ms");
        act(() => vi.advanceTimersByTime(60));
        expect(screen.getByRole("status")).toHaveTextContent("Compiling");

        act(() => {
          worker.emit({
            type: "result",
            id: 2,
            mainPath: "/main.typ",
            diagnostics: [],
            compileMs: 7,
            renderMs: 0,
          });
        });
        expect(screen.getByRole("status")).toHaveTextContent("7 ms");

        // A quick compile that finishes in time never flickers.
        act(() => {
          worker.emit({ type: "compiling", id: 3 });
          vi.advanceTimersByTime(100);
          worker.emit({
            type: "result",
            id: 3,
            mainPath: "/main.typ",
            diagnostics: [],
            compileMs: 8,
            renderMs: 0,
          });
          vi.advanceTimersByTime(500);
        });
        expect(screen.getByRole("status")).toHaveTextContent("8 ms");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("following edits", () => {
    const sizes = { width: 400, height: 300 };
    const blocks = (tid: string, y: number) => ({
      tid,
      width: 100,
      height: 200,
      markup: `<g class="typst-page" data-tid="${tid}" data-page-width="100" data-page-height="200"><g class="typst-group"><g transform="translate(0, ${y})" data-tid="${tid}b"/></g></g>`,
    });
    const render = (...tids: string[]): RenderPayload => ({
      ...fullRender,
      pages: tids.map((t) => blocks(t, 10)),
    });
    let id = 0;
    const compileEdit = (
      worker: FakeWorker,
      project: ProjectDoc,
      payload: RenderPayload,
    ) => {
      act(() => {
        getText(project, project.mainFile!).insert(0, "x");
        project.doc.commit();
        worker.emit({ type: "compiling", id: ++id });
        worker.emit({
          type: "result",
          id,
          mainPath: "/main.typ",
          diagnostics: [],
          render: payload,
          compileMs: 1,
          renderMs: 0,
        });
      });
    };

    beforeEach(() => {
      id = 0;
      // jsdom has no layout, so give the viewport a size and a scrollTop
      // that keeps what it is given.
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
        sizes.width,
      );
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
        sizes.height,
      );
      const tops = new WeakMap<Element, number>();
      vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
        function (this: HTMLElement) {
          return tops.get(this) ?? 0;
        },
      );
      vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
        function (this: HTMLElement, v: number) {
          tops.set(this, v);
        },
      );
    });
    afterEach(() => vi.restoreAllMocks());

    it("scrolls to an edit on a page that is out of view", async () => {
      const { worker, project } = setup();
      await act(async () => {
        worker.emit({ type: "ready" });
        worker.emit({ type: "compiling", id: ++id });
        worker.emit({
          type: "result",
          id,
          mainPath: "/main.typ",
          diagnostics: [],
          render: render("a", "b"),
          compileMs: 1,
          renderMs: 0,
        });
      });
      const viewport = screen.getByTestId("preview-viewport");
      expect(viewport.scrollTop).toBe(0);

      // Page 2 starts at 16 + 736 + 16 = 768 in a 368 wide column.
      compileEdit(worker, project, render("a", "c"));
      expect(viewport.scrollTop).toBeCloseTo(768 + 10 * 3.68 - 100);
    });

    it("leaves the preview alone after the user scrolled it", async () => {
      const { worker, project } = setup();
      await act(async () => {
        worker.emit({ type: "ready" });
        worker.emit({ type: "compiling", id: ++id });
        worker.emit({
          type: "result",
          id,
          mainPath: "/main.typ",
          diagnostics: [],
          render: render("a", "b"),
          compileMs: 1,
          renderMs: 0,
        });
      });
      const viewport = screen.getByTestId("preview-viewport");
      fireEvent.wheel(viewport, { deltaY: 10 });
      compileEdit(worker, project, render("a", "c"));
      expect(viewport.scrollTop).toBe(0);
    });

    it("does not count its own scrolling as the user's", async () => {
      const { worker, project } = setup();
      await act(async () => {
        worker.emit({ type: "ready" });
        worker.emit({ type: "compiling", id: ++id });
        worker.emit({
          type: "result",
          id,
          mainPath: "/main.typ",
          diagnostics: [],
          render: render("a", "b", "c"),
          compileMs: 1,
          renderMs: 0,
        });
      });
      const viewport = screen.getByTestId("preview-viewport");
      compileEdit(worker, project, render("a", "x", "c"));
      const first = viewport.scrollTop;
      expect(first).toBeGreaterThan(0);
      fireEvent.scroll(viewport);
      compileEdit(worker, project, render("a", "x", "y"));
      expect(viewport.scrollTop).toBeGreaterThan(first);
    });
  });

  describe("jumps", () => {
    beforeEach(() => {
      // Same stand-in layout as for following edits: a 400 x 300 viewport,
      // so pages fit at 3.68 px per pt, page 1 at (16, 16) and page 2 at
      // y = 16 + 736 + 16.
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
        400,
      );
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
        300,
      );
      const tops = new WeakMap<Element, number>();
      vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
        function (this: HTMLElement) {
          return tops.get(this) ?? 0;
        },
      );
      vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
        function (this: HTMLElement, v: number) {
          tops.set(this, v);
        },
      );
    });
    afterEach(() => vi.restoreAllMocks());

    function setupJumps() {
      const project = initProject(newProject(1), { title: "T" });
      const worker = new FakeWorker();
      const client = new CompilerClient(project, { worker });
      const onJump = vi.fn();
      const view = (scrollTarget: PreviewScrollTarget | null) => (
        <TooltipProvider>
          <PreviewPane
            client={client}
            onJump={onJump}
            scrollTarget={scrollTarget}
          />
        </TooltipProvider>
      );
      const result = render(view(null));
      return {
        worker,
        onJump,
        retarget: (target: PreviewScrollTarget) =>
          result.rerender(view(target)),
      };
    }

    it("asks where a Mod+Clicked spot came from", async () => {
      const { worker, onJump } = setupJumps();
      await compile(worker, []);
      worker.sent = [];

      const viewport = screen.getByTestId("preview-viewport");
      fireEvent.mouseDown(viewport, {
        ...MOD,
        clientX: 16 + 10 * 3.68,
        clientY: 16 + 20 * 3.68,
      });
      const [request] = worker.sent;
      expect(request).toMatchObject({ type: "jumpFromClick", page: 0 });
      const { x, y, id } = request as Extract<
        WorkerRequest,
        { type: "jumpFromClick" }
      >;
      expect(x).toBeCloseTo(10);
      expect(y).toBeCloseTo(20);

      await act(async () => {
        worker.emit({
          type: "jump",
          id,
          target: { kind: "source", path: "/main.typ", package: "", offset: 4 },
        });
      });
      expect(onJump).toHaveBeenCalledWith({
        kind: "source",
        path: "main.typ",
        offset: 4,
      });
    });

    it("ignores a Mod+Click between pages", async () => {
      const { worker } = setupJumps();
      await compile(worker, []);
      worker.sent = [];
      fireEvent.mouseDown(screen.getByTestId("preview-viewport"), {
        ...MOD,
        clientX: 200,
        clientY: 760,
      });
      expect(worker.sent).toEqual([]);
    });

    it("leaves a plain click alone", async () => {
      const { worker } = setupJumps();
      await compile(worker, []);
      worker.sent = [];
      fireEvent.mouseDown(screen.getByTestId("preview-viewport"), {
        clientX: 16 + 10 * 3.68,
        clientY: 16 + 20 * 3.68,
      });
      expect(worker.sent).toEqual([]);
    });

    it("scrolls a jump target a third of the way down the viewport", async () => {
      const { worker, retarget } = setupJumps();
      await compile(worker, []);
      const viewport = screen.getByTestId("preview-viewport");

      retarget({
        points: [{ page: 1, x: 50, y: 100 }],
        baseline: true,
        seq: 1,
      });
      expect(viewport.scrollTop).toBeCloseTo(768 + 100 * 3.68 - 100);

      // Of several, the first at or below the current scroll position.
      retarget({
        points: [
          { page: 0, x: 50, y: 10 },
          { page: 1, x: 50, y: 150 },
        ],
        baseline: true,
        seq: 2,
      });
      expect(viewport.scrollTop).toBeCloseTo(768 + 150 * 3.68 - 100);
    });

    it("does not replay the last jump when it mounts again", async () => {
      const project = initProject(newProject(1), { title: "T" });
      const worker = new FakeWorker();
      const client = new CompilerClient(project, { worker });
      await compile(worker, []);
      // As after closing a version: the workspace still holds the last
      // jump, which this fresh preview never asked for.
      render(
        <TooltipProvider>
          <PreviewPane
            client={client}
            scrollTarget={{
              points: [{ page: 1, x: 50, y: 10 }],
              baseline: true,
              seq: 3,
            }}
          />
        </TooltipProvider>,
      );
      const mark = document.querySelector('[style*="var(--warning)"]');
      expect(mark).toBeNull();
    });
  });
});
