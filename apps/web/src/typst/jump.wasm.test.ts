// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  createTypstCompiler,
  type TypstCompiler,
} from "@myriaddreamin/typst.ts/compiler";
import { loadFonts } from "@myriaddreamin/typst.ts/options.init";

import { jumpCompiler, toJumpTarget, toPagePosition } from "./jump";

const vendor = path.resolve(
  import.meta.dirname,
  "../../vendor/typst-ts-web-compiler",
);
const wasmPath = path.join(vendor, "pkg/typst_ts_web_compiler_bg.wasm");
// Text needs a font to lay out glyphs, and the CDN fonts the app uses are
// off limits in tests, so the build script leaves one next to the wasm.
const fontPath = path.join(vendor, "test-fonts/LibertinusSerif-Regular.otf");

const missing = [wasmPath, fontPath].filter((f) => !existsSync(f));
const reason =
  missing.length > 0
    ? `missing ${missing.map((f) => path.relative(vendor, f)).join(", ")} in vendor/typst-ts-web-compiler; run apps/web/scripts/build-typst-compiler.sh`
    : null;
// Typecheck and the other tests fail without the build anyway, but CI
// passing with these skipped would hide a broken jump patch.
if (reason && process.env.CI) throw new Error(reason);
if (reason) console.warn(`Skipping the compiler jump tests: ${reason}`);

const MAIN = [
  "= First",
  "Some text.",
  "#pagebreak()",
  "= Second heading",
  '#link("https://example.com")[a link]',
  "",
].join("\n");

// The emoji and umlauts make byte, code point and UTF-16 offsets differ.
const UNICODE = '= Ü 👋 ü target\n#link("https://example.com")[a link]\n';

describe.skipIf(reason !== null)(
  "source/preview jumps (patched compiler)",
  () => {
    let compiler: TypstCompiler;

    beforeAll(async () => {
      compiler = createTypstCompiler();
      await compiler.init({
        getWrapper: () => import("@myriaddreamin/typst-ts-web-compiler"),
        getModule: () => readFileSync(wasmPath),
        beforeBuild: [
          loadFonts([new Uint8Array(readFileSync(fontPath))], {
            assets: false,
          }),
        ],
      });
    }, 60_000);

    it("answers nothing before the first compile", () => {
      const raw = jumpCompiler(compiler);
      expect(raw.jump_from_click(0, 10, 10)).toBeNull();
      expect(raw.jump_from_cursor("/main.typ", 0)).toEqual([]);
    });

    it("jumps both ways between a heading on page 2 and its source", async () => {
      compiler.addSource("/main.typ", MAIN);
      // The path the worker takes for diagnostics.
      const check = await compiler.runWithWorld(
        { mainFilePath: "/main.typ" },
        (world) => world.compile({ diagnostics: "full" }),
      );
      expect(check.hasError).toBe(false);

      const raw = jumpCompiler(compiler);
      const headingAt = MAIN.indexOf("Second heading");
      const positions = raw
        .jump_from_cursor("/main.typ", headingAt + 3)
        .map(toPagePosition);
      expect(positions).toHaveLength(1);
      const [pos] = positions;
      expect(pos?.page).toBe(1);
      expect(pos?.x).toBeGreaterThan(0);
      expect(pos?.y).toBeGreaterThan(0);

      // The cursor jump lands on the glyph's baseline; the click box of a
      // glyph extends one font size above it.
      const target = toJumpTarget(
        raw.jump_from_click(pos!.page, pos!.x + 1, pos!.y - 2),
      );
      expect(target).toMatchObject({
        kind: "source",
        path: "/main.typ",
        package: "",
      });
      const offset = target?.kind === "source" ? target.offset : -1;
      expect(offset).toBeGreaterThanOrEqual(headingAt);
      expect(offset).toBeLessThanOrEqual(headingAt + "Second heading".length);

      expect(raw.jump_from_click(5, 10, 10)).toBeNull();
    });

    it("counts offsets in UTF-16 and finds links", async () => {
      const src = UNICODE;
      compiler.addSource("/main.typ", src);
      // The export path the worker takes for the preview.
      await compiler.compile({ mainFilePath: "/main.typ" });

      const raw = jumpCompiler(compiler);
      const at = src.indexOf("target");
      // typst-ide answers with the start of the whole text node, here the
      // "Ü", not the glyph under the cursor.
      const [pos] = raw
        .jump_from_cursor("/main.typ", at + 1)
        .map(toPagePosition);
      expect(pos?.page).toBe(0);
      // Sweep the line: some click has to land right before "target", which
      // only works out if the offsets are UTF-16 (bytes would be 4 further).
      const offsets = new Set<number>();
      for (let dx = 0.5; dx < 80; dx += 0.5) {
        const t = toJumpTarget(
          raw.jump_from_click(pos!.page, pos!.x + dx, pos!.y - 2),
        );
        if (t?.kind === "source") offsets.add(t.offset);
      }
      expect(offsets).toContain(at);
      expect(Math.max(...offsets)).toBeLessThanOrEqual(src.indexOf("\n"));

      const link = src.indexOf("a link");
      const [linkPos] = raw
        .jump_from_cursor("/main.typ", link + 1)
        .map(toPagePosition);
      expect(
        toJumpTarget(
          raw.jump_from_click(linkPos!.page, linkPos!.x + 1, linkPos!.y - 2),
        ),
      ).toEqual({ kind: "url", url: "https://example.com" });
    });

    it("follows internal links and finds repeated text", async () => {
      const src = "#outline()\n#pagebreak()\n= Far away\n";
      compiler.addSource("/main.typ", src);
      await compiler.compile({ mainFilePath: "/main.typ" });

      const raw = jumpCompiler(compiler);
      // The outline entry repeats the heading's text, with the same span.
      const positions = raw
        .jump_from_cursor("/main.typ", src.indexOf("Far") + 1)
        .map(toPagePosition);
      expect(positions.map((p) => p?.page)).toEqual([0, 1]);
      const [entry, heading] = positions;
      const target = toJumpTarget(
        raw.jump_from_click(0, entry!.x + 1, entry!.y - 2),
      );
      expect(target).toMatchObject({ kind: "position", page: 1 });
      // The link target is the heading's top, above its baseline.
      expect(target?.kind === "position" && target.y).toBeLessThan(heading!.y);
    });

    it("keeps the last good document when a compile fails", async () => {
      const good = "Kept text\n";
      compiler.addSource("/main.typ", good);
      await compiler.compile({ mainFilePath: "/main.typ" });
      compiler.addSource("/main.typ", "#let x = (\nKept text\n");
      const check = await compiler.runWithWorld(
        { mainFilePath: "/main.typ" },
        (world) => world.compile({ diagnostics: "full" }),
      );
      expect(check.hasError).toBe(true);
      // Still the previous document, resolved against its own source: in
      // the broken text offset 2 is code, in the good one it is text.
      expect(
        jumpCompiler(compiler).jump_from_cursor("/main.typ", 2),
      ).toHaveLength(1);
    });
  },
);
