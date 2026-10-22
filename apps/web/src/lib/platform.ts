function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // navigator.platform is deprecated but still the most reliable signal;
  // userAgentData is Chromium-only and not in the DOM typings.
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Apple platforms use Cmd where everyone else uses Ctrl. */
export const IS_MAC = detectMac();

/**
 * Splits a shortcut like "Mod+Shift+P" into the key labels to show, with
 * Mod resolved for this platform.
 */
export function shortcutKeys(combo: string): string[] {
  return combo.split("+").map((part) => {
    switch (part) {
      case "Mod":
        return IS_MAC ? "⌘" : "Ctrl";
      case "Shift":
        return IS_MAC ? "⇧" : "Shift";
      case "Alt":
        return IS_MAC ? "⌥" : "Alt";
      default:
        return part.length === 1 ? part.toUpperCase() : part;
    }
  });
}

/** A shortcut as one string, e.g. "⌘B" on a Mac and "Ctrl+B" elsewhere. */
export function formatShortcut(combo: string): string {
  return shortcutKeys(combo).join(IS_MAC ? "" : "+");
}

/**
 * Cmd+Click on Apple platforms, Ctrl+Click elsewhere. On a Mac Ctrl+Click
 * opens the context menu, so the two can't be treated alike.
 */
export function isModClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (event.button !== 0 || event.altKey || event.shiftKey) return false;
  return IS_MAC
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

/** The `aria-keyshortcuts` value for a combo, e.g. "Meta+B". */
export function ariaKeyShortcut(combo: string): string {
  return combo
    .split("+")
    .map((part) => (part === "Mod" ? (IS_MAC ? "Meta" : "Control") : part))
    .join("+");
}
