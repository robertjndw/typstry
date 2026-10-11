import { UserXIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Notice } from "@/components/Notice";

/**
 * Shown to a device the group removed. Its links were replaced, so it can
 * no longer read what is added to the project from now on. What it already
 * has stays in this browser.
 */
export function RemovedNotice({ actions }: { actions: ReactNode }) {
  return (
    <Notice
      icon={UserXIcon}
      title="You were removed from this project"
      actions={actions}
    >
      An editor removed this device, and the links it had were replaced. Changes
      made from now on will not reach it. Ask someone in the project for the new
      link if you should still have access.
    </Notice>
  );
}
