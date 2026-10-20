import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { addComment, listThreads, reply } from "@/doc/comments";
import { getText } from "@/doc/fs-ops";
import { initProject, type ProjectDoc } from "@/doc/schema";
import { fork, newProject, sync } from "@/doc/test-utils";
import { IDENTITY_KEY, resetIdentityCache } from "@/presence/identity";
import { CommentsUi, CommentsUiContext } from "@/project/comments-ui";
import { ProjectProvider } from "@/project/ProjectProvider";
import { RevealContext, type RevealFn } from "@/project/reveal-context";

import { CommentsPanel } from "./CommentsPanel";

const GRACE = { name: "Grace", color: "#cc6633" };

function setup(options: { readOnly?: boolean } = {}) {
  const project = initProject(newProject(1), { title: "Test" });
  const main = project.mainFile!;
  const other = fork(project, 2);
  const ui = new CommentsUi();
  const reveal = vi.fn<RevealFn>();
  render(
    <TooltipProvider>
      <ProjectProvider doc={project} readOnly={options.readOnly}>
        <RevealContext value={reveal}>
          <CommentsUiContext value={ui}>
            <CommentsPanel />
          </CommentsUiContext>
        </RevealContext>
      </ProjectProvider>
    </TooltipProvider>,
  );
  return { project, other, main, ui, reveal };
}

/** Comments on the first `word` in main.typ as whoever `project` is. */
function commentOn(
  project: ProjectDoc,
  word: string,
  body: string,
  author = GRACE,
) {
  const main = project.mainFile!;
  const text = getText(project, main);
  const from = text.toString().indexOf(word);
  return addComment(project, {
    fileId: main,
    text,
    from,
    to: from + word.length,
    body,
    ...author,
  });
}

const threads = () => screen.queryAllByRole("article");

describe("CommentsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({ name: "Ada", color: "#3366cc" }),
    );
    resetIdentityCache();
  });

  it("lists threads in document order, live as peers comment", () => {
    const { project, other } = setup();
    expect(screen.getByText(/No comments yet/)).toBeInTheDocument();

    act(() => {
      commentOn(other, "Typst!", "Exclamation?");
      commentOn(other, "set page", "A4 is fine");
      sync(project, other);
    });
    expect(
      threads().map(
        (t) =>
          within(t).getByRole("button", { name: /page|Typst/ }).textContent,
      ),
    ).toEqual(["set page", "Typst!"]);
    const first = threads()[0]!;
    expect(first).toHaveAccessibleName("Comment by Grace");
    expect(within(first).getByText("A4 is fine")).toBeInTheDocument();
  });

  it("reveals a thread's range when its quote is clicked", () => {
    const { project, main, ui, reveal } = setup();
    let id = "";
    act(() => void (id = commentOn(project, "Hello", "Hi")));
    fireEvent.click(screen.getByRole("button", { name: "Hello" }));
    const from = getText(project, main).toString().indexOf("Hello");
    expect(reveal).toHaveBeenCalledWith(main, {
      kind: "offset",
      from,
      to: from + 5,
    });
    expect(ui.getState().active).toBe(id);
  });

  it("replies, resolves and reopens", () => {
    const { project } = setup();
    act(() => void commentOn(project, "Hello", "Hi"));

    const box = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(box, { target: { value: "Line one\nline two" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const [thread] = listThreads(project);
    expect(thread!.replies.map((r) => [r.body, r.name])).toEqual([
      ["Line one\nline two", "Ada"],
    ]);
    // Plain text, newlines kept.
    expect(screen.getByText(/Line one/).textContent).toBe("Line one\nline two");

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(listThreads(project)[0]!.resolvedAt).not.toBeNull();
    expect(threads()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Show resolved" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(listThreads(project)[0]!.resolvedAt).toBeNull();
  });

  it("offers delete only on the person's own comments", () => {
    const { project, other } = setup();
    act(() => {
      const theirs = commentOn(other, "Hello", "Theirs");
      sync(project, other);
      reply(project, theirs, { body: "Mine", name: "Ada", color: "#3366cc" });
    });
    const thread = threads()[0]!;
    expect(
      within(thread).queryByRole("button", { name: "Delete thread" }),
    ).toBeNull();
    fireEvent.click(
      within(thread).getByRole("button", { name: "Delete reply" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(listThreads(project)[0]!.replies).toEqual([]);
  });

  it("deletes a whole thread after confirming", () => {
    const { project } = setup();
    act(() => void commentOn(project, "Hello", "Mine"));
    fireEvent.click(screen.getByRole("button", { name: "Delete thread" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/all its replies/);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(listThreads(project)).toEqual([]);
  });

  it("shows threads whose text is gone as detached", () => {
    const { project, main } = setup();
    act(() => {
      commentOn(project, "Hello", "Gone soon");
      const text = getText(project, main);
      text.delete(text.toString().indexOf("Hello"), 5);
      project.doc.commit();
    });
    const section = screen.getByRole("region", { name: "Detached" });
    expect(within(section).getByText("Hello")).toBeInTheDocument();
    expect(within(section).getByText("Gone soon")).toBeInTheDocument();
    // No range to jump to.
    expect(within(section).queryByRole("button", { name: "Hello" })).toBeNull();
  });

  it("writes a drafted comment with the stored identity", () => {
    const { project, main, ui } = setup();
    const text = getText(project, main);
    const from = text.toString().indexOf("Typst!");
    act(() => {
      ui.setSelection({ fileId: main, text, from, to: from + 5 });
      ui.startDraft();
    });
    const form = screen.getByRole("form", { name: "New comment" });
    expect(within(form).getByText("Typst")).toBeInTheDocument();

    // Text typed before the selection while writing moves it, not the
    // comment's range.
    act(() => {
      text.insert(0, "// new first line\n");
      project.doc.commit();
    });
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment" }), {
      target: { value: "  Bold?  " },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Comment" }));

    const [thread] = listThreads(project);
    expect(thread!.root).toMatchObject({
      body: "Bold?",
      quote: "Typst",
      name: "Ada",
      color: "#3366cc",
    });
    expect(screen.queryByRole("form", { name: "New comment" })).toBeNull();
    expect(ui.getState().active).toBe(thread!.id);
  });

  it("is read-only for viewers", () => {
    const { project, main, ui } = setup({ readOnly: true });
    act(() => {
      commentOn(project, "Hello", "Visible");
      const text = getText(project, main);
      ui.setSelection({ fileId: main, text, from: 0, to: 3 });
      ui.startDraft();
    });
    expect(screen.getByText("Visible")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "New comment" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  });
});
