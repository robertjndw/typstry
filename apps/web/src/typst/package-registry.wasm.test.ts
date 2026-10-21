// @vitest-environment node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  CompileFormatEnum,
  createTypstCompiler,
  type TypstCompiler,
} from "@myriaddreamin/typst.ts/compiler";
import { MemoryAccessModel } from "@myriaddreamin/typst.ts/fs/memory";
import {
  withAccessModel,
  withPackageRegistry,
} from "@myriaddreamin/typst.ts/options.init";

import { gzipDeterministic } from "@/packages/gzip";
import { writeTar } from "@/packages/tar";

import { ProjectPackageRegistry } from "./package-registry";

const encoder = new TextEncoder();

function archive(width: string): Uint8Array {
  return gzipDeterministic(
    writeTar(
      new Map([
        [
          "typst.toml",
          encoder.encode(
            '[package]\nname = "hello"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n',
          ),
        ],
        ["lib.typ", encoder.encode(`#let hello = rect(width: ${width})`)],
      ]),
    ),
  );
}

async function build(registry: ProjectPackageRegistry, am: MemoryAccessModel) {
  const wasm = createRequire(import.meta.url).resolve(
    "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm",
  );
  const compiler = createTypstCompiler();
  await compiler.init({
    getModule: () => readFile(wasm),
    beforeBuild: [withAccessModel(am), withPackageRegistry(registry)],
  });
  return compiler;
}

async function render(compiler: TypstCompiler): Promise<{
  errors: string[];
  artifact: string;
}> {
  const check = await compiler.runWithWorld(
    { mainFilePath: "/main.typ" },
    (world) => world.compile({ diagnostics: "full" }),
  );
  const errors = (check.diagnostics ?? []).map((d) => d.message);
  if (check.hasError) return { errors, artifact: "" };
  const { result } = await compiler.compile({
    mainFilePath: "/main.typ",
    format: CompileFormatEnum.vector,
  });
  return { errors, artifact: Array.from(result ?? []).join(",") };
}

describe("project packages in the real compiler", () => {
  it("keeps a cached package answer through reset(), so the worker rebuilds", async () => {
    const am = new MemoryAccessModel();
    const registry = new ProjectPackageRegistry(am, {
      resolve: () => undefined,
    });
    const compiler = await build(registry, am);
    compiler.addSource(
      "/main.typ",
      '#import "@local/hello:0.1.0": hello\n#hello',
    );
    const missing = await render(compiler);
    expect(missing.errors.join("\n")).toContain("package not found");

    // The registry reports that this compiler has already seen the package.
    expect(
      registry.set("local/hello/0.1.0", "a".repeat(64), archive("10pt")),
    ).toBe(true);
    await compiler.reset();
    const stillMissing = await render(compiler);
    expect(stillMissing.errors.join("\n")).toContain("package not found");
  }, 60_000);

  it("picks up added and replaced packages on a new compiler", async () => {
    const am = new MemoryAccessModel();
    const registry = new ProjectPackageRegistry(am, {
      resolve: () => undefined,
    });
    const main = '#import "@local/hello:0.1.0": hello\n#hello';

    // Nothing has asked for the package yet, so adding it is not stale.
    expect(
      registry.set("local/hello/0.1.0", "a".repeat(64), archive("10pt")),
    ).toBe(false);
    const one = await build(registry, am);
    one.addSource("/main.typ", main);
    const first = await render(one);
    expect(first.errors).toEqual([]);
    expect(first.artifact.length).toBeGreaterThan(0);

    expect(
      registry.set("local/hello/0.1.0", "b".repeat(64), archive("20pt")),
    ).toBe(true);
    registry.forgetLookups();
    const two = await build(registry, am);
    two.addSource("/main.typ", main);
    const second = await render(two);
    expect(second.errors).toEqual([]);
    expect(second.artifact).not.toBe(first.artifact);
  }, 60_000);
});
