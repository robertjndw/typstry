import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

import { refreshDirectoryService } from "@/directory/service";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { routes } from "@/router";
import { pruneStaleCaches } from "@/typst/cache-names";
import "./index.css";

void pruneStaleCaches();
// Does nothing unless this browser has a personal space, so merely visiting
// never makes a device key or opens the directory.
void refreshDirectoryService().catch((error) =>
  console.warn("could not start the directory sync", error),
);

const router = createBrowserRouter(routes);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" disableTransitionOnChange>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
