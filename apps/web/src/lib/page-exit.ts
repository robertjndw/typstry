/**
 * Calls `onExit` when the page is hidden or unloaded. Hidden is the last
 * reliable moment to save: a closing tab gets no second chance, mobile may
 * never fire `pagehide`, and a hidden tab's timers can be throttled for
 * minutes. Returns the function that stops listening; outside a browser
 * there is nothing to listen to.
 */
export function onPageExit(onExit: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const abort = new AbortController();
  const options = { signal: abort.signal };
  window.addEventListener("pagehide", onExit, options);
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") onExit();
    },
    options,
  );
  return () => abort.abort();
}
