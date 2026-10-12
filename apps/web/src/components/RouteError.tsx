import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { isRouteErrorResponse, useRouteError } from "react-router";

import { Notice } from "@/components/Notice";
import { Button } from "@/components/ui/button";
import { toError } from "@/lib/errors";

/**
 * Error page for routes that throw while rendering. The likeliest cause is a
 * project stored in an older format that the wasm can no longer decode.
 */
export function RouteError() {
  const error = useRouteError();
  if (!isRouteErrorResponse(error)) console.error(error);
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : toError(error).message;

  return (
    <Notice
      icon={TriangleAlertIcon}
      tone="destructive"
      title="Could not open this page"
      actions={
        <>
          <Button onClick={() => location.reload()}>
            <RotateCwIcon />
            Try again
          </Button>
          {/* Plain link, a client-side navigation would reuse the broken router state. */}
          <Button asChild variant="outline">
            <a href="/">Go to the start page</a>
          </Button>
        </>
      }
    >
      If this is an old project, it may be stored in a format this version
      cannot read anymore.
      {detail && (
        <code className="mt-3 block rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          {detail}
        </code>
      )}
    </Notice>
  );
}
