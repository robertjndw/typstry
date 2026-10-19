import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

import { refreshDirectoryService } from "@/directory/service";
import { LOCAL_ONLY } from "@/mode";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StorageNotice } from "@/persist/StorageNotice";
import { routes } from "@/router";
import { pruneStaleCaches } from "@/typst/cache-names";
import "./index.css";

void pruneStaleCaches();
// Does nothing unless this browser has a personal space, so merely visiting
// never makes a device key or opens the directory.
if (!LOCAL_ONLY) {
  void refreshDirectoryService().catch((error) =>
    console.warn("could not start the directory sync", error),
  );
}

// The static build is served from a subpath (/<repo>/) on GitHub Pages.
const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL.replace(/\/$/, "") || "/",
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" disableTransitionOnChange>
      <TooltipProvider>
        <RouterProvider router={router} />
        {/* Fixed rather than in the flow: pages are sized to the viewport,
            and this covers every route, Home included. */}
        <div className="fixed inset-x-0 bottom-0 z-50 bg-background empty:hidden">
          <StorageNotice />
        </div>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
