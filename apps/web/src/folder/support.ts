/** Chromium only, and only on secure origins. */
export function folderSyncSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof window.showDirectoryPicker === "function"
  );
}

/**
 * Asks the user for a folder. Has to run inside a click handler, before any
 * await, or the browser refuses to show the picker. Null when dismissed.
 */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker!({
      mode: "readwrite",
      id: "typstry",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}
