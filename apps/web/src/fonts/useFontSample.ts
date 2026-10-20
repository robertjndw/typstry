import { useEffect, useState } from "react";

export type FontSampleStatus =
  "idle" | "loading" | "ready" | "error" | "unsupported";

export interface FontSample {
  /** CSS family to render the sample with, once the font is registered. */
  family?: string;
  status: FontSampleStatus;
}

/**
 * Registers the font with the document so a sample line can be set in it.
 * Nothing is fetched until `visible`, since a project can hold many fonts.
 * The FontFace API cannot choose a face inside a collection, so only the
 * first face of a .ttc gets a sample.
 */
export function useFontSample(
  loadBytes: (hash: string) => Promise<Uint8Array>,
  hash: string,
  index: number,
  visible: boolean,
): FontSample {
  const family = `typstry-sample-${hash}-${index}`;
  const unsupported = index > 0;
  const [loaded, setLoaded] = useState<{
    family: string;
    status: "ready" | "error";
  } | null>(null);

  useEffect(() => {
    if (!visible || unsupported) return;
    let cancelled = false;
    let face: FontFace | null = null;
    void (async () => {
      try {
        const bytes = await loadBytes(hash);
        // The bytes may be shared with the compiler, so hand over a copy.
        face = new FontFace(family, bytes.slice().buffer);
        await face.load();
        if (cancelled) return;
        document.fonts.add(face);
        setLoaded({ family, status: "ready" });
      } catch {
        face = null;
        if (!cancelled) setLoaded({ family, status: "error" });
      }
    })();
    return () => {
      cancelled = true;
      if (face) document.fonts.delete(face);
    };
  }, [loadBytes, hash, family, visible, unsupported]);

  if (unsupported) return { status: "unsupported" };
  if (loaded?.family === family) {
    return loaded.status === "ready"
      ? { family, status: "ready" }
      : { status: "error" };
  }
  return { status: visible ? "loading" : "idle" };
}
