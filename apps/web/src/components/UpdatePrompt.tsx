import { useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { toast } from "sonner";

/**
 * Offers a reload once a new build has been downloaded in the background.
 * Never reloads on its own, since that would drop unsaved state.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    if (!needRefresh) return;
    const id = toast("A new version is available", {
      duration: Infinity,
      action: {
        label: "Reload",
        onClick: () => void updateServiceWorker(true),
      },
    });
    return () => void toast.dismiss(id);
  }, [needRefresh, updateServiceWorker]);

  return null;
}
