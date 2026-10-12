import type { RouteObject } from "react-router";

import { RouteError } from "@/components/RouteError";
import { Home } from "@/routes/Home";
import { Pair } from "@/routes/Pair";
import { Recover } from "@/routes/Recover";
import { Project } from "@/routes/Project";

export const routes: RouteObject[] = [
  { path: "/", errorElement: <RouteError />, element: <Home /> },
  { path: "/p/:token", errorElement: <RouteError />, element: <Project /> },
  { path: "/pair", errorElement: <RouteError />, element: <Pair /> },
  { path: "/recover", errorElement: <RouteError />, element: <Recover /> },
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
