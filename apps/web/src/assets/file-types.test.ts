// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fileCategory, inertBlobType } from "./file-types";

describe("inertBlobType", () => {
  it("passes through types that cannot run script", () => {
    for (const mime of [
      "image/png",
      "image/jpeg",
      "application/pdf",
      "font/woff2",
      "font/collection",
      "audio/mpeg",
      "video/mp4",
      "text/plain",
    ]) {
      expect(inertBlobType(mime)).toBe(mime);
    }
  });

  it("downgrades active or unknown content to a plain download", () => {
    for (const mime of [
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/xml",
      "text/xml",
      "application/javascript",
      "text/html;charset=utf-8",
      "IMAGE/PNG",
      "",
    ]) {
      expect(inertBlobType(mime)).toBe("application/octet-stream");
    }
  });
});

describe("fileCategory", () => {
  it("classifies by extension, ignoring case", () => {
    expect(fileCategory("main.typ")).toBe("typst");
    expect(fileCategory("Logo.PNG")).toBe("image");
    expect(fileCategory("paper.pdf")).toBe("pdf");
    expect(fileCategory("Inter.woff2")).toBe("font");
    expect(fileCategory("data.csv")).toBe("data");
    expect(fileCategory("notes.txt")).toBe("text");
    expect(fileCategory("README.md")).toBe("text");
    expect(fileCategory(".gitignore")).toBe("other");
  });

  it("prefers a specific mime type over the extension", () => {
    expect(fileCategory("scan", "image/tiff")).toBe("image");
    expect(fileCategory("clip.bin", "video/mp4")).toBe("video");
    expect(fileCategory("x.dat", "application/pdf")).toBe("pdf");
    expect(fileCategory("song.mp3", "application/octet-stream")).toBe("audio");
  });
});
