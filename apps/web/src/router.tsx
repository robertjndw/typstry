import type { RouteObject } from "react-router";

import { RouteError } from "@/components/RouteError";
import { LOCAL_ONLY } from "@/mode";
import { Home } from "@/routes/Home";

export const routes: RouteObject[] = [
  { path: "/", errorElement: <RouteError />, element: <Home /> },
  {
    path: "/p/:token",
    errorElement: <RouteError />,
    // The editor, compiler client and sync stack are most of the bundle, and
    // the start page needs none of them.
    HydrateFallback: () => null,
    lazy: async () => ({
      Component: LOCAL_ONLY
        ? (await import("@/routes/StandaloneProject")).StandaloneProject
        : (await import("@/routes/Project")).Project,
    }),
  },
];

// Pairing and recovery need a server, and the static build has none. Lazy
// so the static bundle leaves them out.
if (!LOCAL_ONLY) {
  routes.push(
    {
      path: "/pair",
      errorElement: <RouteError />,
      HydrateFallback: () => null,
      lazy: async () => ({ Component: (await import("@/routes/Pair")).Pair }),
    },
    {
      path: "/recover",
      errorElement: <RouteError />,
      HydrateFallback: () => null,
      lazy: async () => ({
        Component: (await import("@/routes/Recover")).Recover,
      }),
    },
  );
}

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
