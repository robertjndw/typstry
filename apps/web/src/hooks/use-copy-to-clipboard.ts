import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Copies text and reports `copied` for a short while after, for a check mark
 * on the button. A failure shows `failMessage`, which should tell the user
 * how to copy by hand.
 */
export function useCopyToClipboard(failMessage: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(failMessage);
    }
  }

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    setCopied(false);
  }, []);

  return { copied, copy, reset };
}
