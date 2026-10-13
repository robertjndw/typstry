import { useEffect, useRef, type RefObject } from "react";

import { IS_MAC } from "@/lib/platform";

/** Handlers by combo, e.g. `{ "Mod+S": save }`. Mod is Cmd on a Mac. */
export type ShortcutMap = Partial<
  Record<string, (event: KeyboardEvent) => void>
>;

interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

// The keydown handler runs on every keystroke typed in the editor, and the
// combos are a handful of string literals, so parse each one only once.
const parsed = new Map<string, ParsedCombo>();

function parse(combo: string): ParsedCombo {
  const cached = parsed.get(combo);
  if (cached) return cached;
  const parts = combo.split("+");
  // "Mod++" would split into empty strings; nothing here uses it.
  const key = parts.pop()!.toLowerCase();
  const result = {
    key,
    mod: parts.includes("Mod"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
  parsed.set(combo, result);
  return result;
}

const CODES: Record<string, string> = { "\\": "Backslash", "/": "Slash" };

function matches(event: KeyboardEvent, combo: ParsedCombo): boolean {
  const mod = IS_MAC
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (mod !== combo.mod) return false;
  // Symbols like \ need Shift or Option on some layouts (German Mac:
  // Option+Shift+7), so for those the produced character is what counts.
  const symbol = !/^[a-z0-9]$/.test(combo.key) && combo.key.length === 1;
  if (symbol && !combo.shift && !combo.alt && event.key === combo.key) {
    return true;
  }
  if (event.shiftKey !== combo.shift || event.altKey !== combo.alt) {
    return false;
  }
  if (event.key.toLowerCase() === combo.key) return true;
  // Layouts without latin letters report another key, so fall back to the
  // physical one.
  const code =
    CODES[combo.key] ??
    (/^[a-z]$/.test(combo.key) ? `Key${combo.key.toUpperCase()}` : null);
  return code !== null && event.code === code;
}

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"]';

/** Marks an element whose shortcuts only apply while focus is inside it. */
const SCOPE_ATTR = "data-shortcut-scope";

/**
 * Global keyboard shortcuts. They listen on window in the capture phase so
 * they run before CodeMirror (or anything else focused) can swallow the
 * key, and they always preventDefault so Mod+S or Mod+P never open the
 * browser's own dialogs.
 *
 * With `scope` (an element marked with `data-shortcut-scope`), a key
 * pressed inside another such element is left to that one, which keeps two
 * workspaces on one page (the dev split view) apart.
 */
export function useShortcuts(
  shortcuts: ShortcutMap,
  {
    enabled = true,
    scope,
  }: { enabled?: boolean; scope?: RefObject<HTMLElement | null> } = {},
) {
  // A ref so callers can pass a fresh object every render without
  // re-subscribing.
  const latest = useRef(shortcuts);
  useEffect(() => {
    latest.current = shortcuts;
  });

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      // Keys confirming an IME composition must reach the input method.
      if (event.isComposing || event.keyCode === 229) return;
      if (scope?.current && event.target instanceof Element) {
        const owner = event.target.closest(`[${SCOPE_ATTR}]`);
        if (owner && owner !== scope.current) return;
      }
      // Dialogs are portaled to the end of <body>, outside any scope, and
      // a workspace shortcut acting behind an open dialog (Mod+B hiding the
      // sidebar under it, Mod+P opening a second overlay) is never wanted.
      const inDialog =
        event.target instanceof Element &&
        event.target.closest(DIALOG_SELECTOR) !== null &&
        !(scope?.current && scope.current.contains(event.target));
      for (const [combo, handler] of Object.entries(latest.current)) {
        if (!handler || !matches(event, parse(combo))) continue;
        // Still kept from the browser, whose save or print dialog would be
        // just as unexpected over the app's.
        event.preventDefault();
        if (inDialog) return;
        event.stopPropagation();
        if (!event.repeat) handler(event);
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [enabled, scope]);
}
