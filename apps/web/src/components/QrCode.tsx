import { useMemo } from "react";
import { encode } from "uqr";

const QUIET_ZONE = 2;

/**
 * Drawn as one path instead of injecting markup. Always dark on white,
 * whatever the theme: scanners need the contrast.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const { data, size } = encode(text, { border: 0, ecc: "M" });
    let path = "";
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
      }),
    );
    return { size: size + QUIET_ZONE * 2, path };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-40 rounded-md bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
