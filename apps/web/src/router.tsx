import type { RouteObject } from "react-router";

import { Home } from "@/routes/Home";
import { Project } from "@/routes/Project";

export const routes: RouteObject[] = [
  { path: "/", element: <Home /> },
  { path: "/p/:token", element: <Project /> },
];

if (import.meta.env.DEV) {
  // Lazy so the dev-only module drops out of production builds entirely.
  routes.push({
    path: "/dev/split",
    // Without a fallback, React Router warns while the lazy module loads on
    // a direct visit.
    HydrateFallback: () => null,
    lazy: async () => ({
      Component: (await import("@/routes/DevSplit")).DevSplit,
    }),
  });
  routes.push({
    path: "/dev/preview",
    HydrateFallback: () => null,
    lazy: async () => ({
      Component: (await import("@/typst/PreviewPlayground")).PreviewPlayground,
    }),
  });
}
