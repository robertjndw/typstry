import "./editor.css";

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { typstHighlightTag } from "codemirror-lang-typst";

// Every color comes from a CSS variable (app tokens from index.css, syntax
// tokens from editor.css), so light and dark both work without telling
// CodeMirror which one is active.

const sans = "var(--font-sans, sans-serif)";
const mono = "var(--font-mono, monospace)";
const radius = "calc(var(--radius) - 4px)";
const control = {
  height: "26px",
  padding: "0 8px",
  fontFamily: sans,
  fontSize: "12px",
  color: "var(--foreground)",
  backgroundColor: "var(--background)",
  backgroundImage: "none",
  border: "1px solid var(--input)",
  borderRadius: radius,
  outline: "none",
  verticalAlign: "middle",
  "&:focus-visible": {
    borderColor: "var(--ring)",
    boxShadow: "0 0 0 3px color-mix(in oklch, var(--ring) 40%, transparent)",
  },
};

function wavy(color: string) {
  return {
    backgroundImage: "none",
    textDecoration: `underline wavy ${color}`,
    textDecorationThickness: "1px",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
    paddingBottom: "0",
  };
}

export const editorTheme = EditorView.theme({
  "&": {
    color: "var(--foreground)",
    backgroundColor: "var(--background)",
    fontSize: "13px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: mono,
    lineHeight: "1.65",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
    padding: "8px 0",
  },
  ".cm-line": { padding: "0 16px 0 8px" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--foreground)",
    marginLeft: "-1px",
  },

  ".cm-selectionBackground": { background: "var(--cm-selection-blur)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--cm-selection)",
  },
  ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--cm-match)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--foreground) 10%, transparent)",
    outline:
      "1px solid color-mix(in oklch, var(--foreground) 25%, transparent)",
    borderRadius: "2px",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    backgroundColor: "color-mix(in oklch, var(--destructive) 20%, transparent)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklch, var(--warning) 22%, transparent)",
    outline: "1px solid color-mix(in oklch, var(--warning) 45%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected, .cm-searchMatch-selected *": {
    backgroundColor: "color-mix(in oklch, var(--warning) 45%, transparent)",
  },
  ".cm-specialChar": { color: "var(--destructive)" },
  ".cm-placeholder": {
    color: "var(--muted-foreground)",
    fontStyle: "normal",
  },

  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "color-mix(in oklch, var(--muted-foreground) 70%, transparent)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "32px",
    padding: "0 4px 0 12px",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--foreground)",
  },
  ".cm-foldGutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    color: "var(--muted-foreground)",
  },
  ".cm-foldMarker": {
    display: "flex",
    cursor: "pointer",
    borderRadius: "3px",
    transition: "opacity 150ms, color 150ms",
    "&:hover": { color: "var(--foreground)" },
    "& svg": { width: "12px", height: "12px" },
  },
  // Open markers only matter when you go looking for them; closed ones mark
  // hidden text and stay visible.
  ".cm-foldMarker-open": { opacity: "0" },
  ".cm-gutters:hover .cm-foldMarker-open": { opacity: "1" },
  ".cm-foldMarker-closed svg": { transform: "rotate(-90deg)" },
  ".cm-foldPlaceholder": {
    margin: "0 4px",
    padding: "0 6px",
    color: "var(--muted-foreground)",
    backgroundColor: "var(--muted)",
    border: "none",
    borderRadius: radius,
    fontFamily: sans,
    fontSize: "11px",
  },

  ".cm-panels": {
    color: "var(--foreground)",
    backgroundColor: "var(--background)",
    fontFamily: sans,
  },
  ".cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-textfield": { ...control, cursor: "text" },
  ".cm-button": {
    ...control,
    cursor: "pointer",
    "&:hover": { backgroundColor: "var(--accent)" },
    "&:active": { backgroundImage: "none" },
  },
  ".cm-panel.cm-search": {
    padding: "6px 32px 6px 8px",
    fontSize: "12px",
    "& input, & button, & label": { margin: "2px 6px 2px 0" },
    "& label": {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      fontSize: "12px",
      color: "var(--muted-foreground)",
      verticalAlign: "middle",
    },
    "& input[type=checkbox]": {
      margin: "0",
      accentColor: "var(--primary)",
    },
    "& [name=close]": {
      top: "6px",
      right: "6px",
      width: "22px",
      height: "22px",
      fontSize: "16px",
      lineHeight: "1",
      color: "var(--muted-foreground)",
      borderRadius: radius,
      cursor: "pointer",
      "&:hover": {
        color: "var(--foreground)",
        backgroundColor: "var(--accent)",
      },
    },
  },
  ".cm-dialog": { fontSize: "12px" },

  ".cm-tooltip": {
    color: "var(--popover-foreground)",
    backgroundColor: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: "calc(var(--radius) - 2px)",
    boxShadow:
      "0 4px 12px -2px rgb(0 0 0 / 0.12), 0 2px 4px -2px rgb(0 0 0 / 0.08)",
    fontFamily: sans,
    fontSize: "12.5px",
  },
  ".cm-tooltip-section:not(:first-child)": {
    borderTop: "1px solid var(--border)",
  },
  ".cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: "var(--border)",
    borderBottomColor: "var(--border)",
  },
  ".cm-tooltip .cm-tooltip-arrow:after": {
    borderTopColor: "var(--popover)",
    borderBottomColor: "var(--popover)",
  },

  ".cm-tooltip.cm-tooltip-autocomplete": {
    padding: "0",
    "& > ul": {
      fontFamily: mono,
      fontSize: "12.5px",
      maxHeight: "16em",
      minWidth: "220px",
      padding: "4px",
      "& > li, & > completion-section": {
        lineHeight: "1.5",
      },
      "& > li": {
        display: "flex",
        alignItems: "center",
        padding: "3px 8px 3px 6px",
        borderRadius: radius,
      },
      "& > completion-section": {
        padding: "6px 8px 2px",
        borderBottom: "none",
        fontFamily: sans,
        fontSize: "11px",
        fontWeight: "500",
        color: "var(--muted-foreground)",
        opacity: "1",
      },
    },
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    color: "var(--accent-foreground)",
    background: "var(--accent)",
  },
  ".cm-tooltip-autocomplete-disabled ul li[aria-selected]": {
    color: "var(--muted-foreground)",
    background: "var(--muted)",
  },
  ".cm-completionIcon": {
    width: "1em",
    paddingRight: "8px",
    fontSize: "11px",
    color: "var(--muted-foreground)",
    opacity: "1",
  },
  ".cm-completionLabel": {
    flexShrink: "0",
    whiteSpace: "pre",
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "600",
    color: "var(--foreground)",
  },
  ".cm-completionDetail": {
    minWidth: "0",
    maxWidth: "24em",
    marginLeft: "auto",
    paddingLeft: "16px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: sans,
    fontSize: "11.5px",
    fontStyle: "normal",
    color: "var(--muted-foreground)",
  },
  ".cm-tooltip.cm-completionInfo": {
    padding: "8px 10px",
    lineHeight: "1.5",
  },
  ".cm-completionInfo .cm-lsp-documentation": { padding: "0" },
  ".cm-completionInfo.cm-completionInfo-right": { marginLeft: "4px" },
  ".cm-completionInfo.cm-completionInfo-left": { marginRight: "4px" },

  // tinymist sends Markdown, which the LSP client renders to HTML.
  ".cm-lsp-documentation": {
    padding: "8px 10px",
    whiteSpace: "normal",
    lineHeight: "1.5",
    "& p, & ul, & ol, & pre, & blockquote": { margin: "0 0 8px" },
    "& > :last-child": { marginBottom: "0" },
    "& h1, & h2, & h3, & h4": {
      margin: "12px 0 4px",
      fontSize: "12.5px",
      fontWeight: "600",
    },
    "& > h1:first-child, & > h2:first-child, & > h3:first-child": {
      marginTop: "0",
    },
    "& ul, & ol": { paddingLeft: "18px" },
    "& ul": { listStyle: "disc" },
    "& ol": { listStyle: "decimal" },
    "& a": {
      color: "var(--tok-link)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
    },
    "& code": {
      fontFamily: mono,
      fontSize: "11.5px",
      padding: "1px 4px",
      borderRadius: "3px",
      backgroundColor: "var(--muted)",
    },
    "& pre": {
      padding: "6px 8px",
      borderRadius: radius,
      backgroundColor: "var(--muted)",
      overflowX: "auto",
    },
    "& pre code": { padding: "0", backgroundColor: "transparent" },
    "& hr": {
      margin: "8px 0",
      border: "none",
      borderTop: "1px solid var(--border)",
    },
    "& blockquote": {
      paddingLeft: "8px",
      borderLeft: "2px solid var(--border)",
      color: "var(--muted-foreground)",
    },
  },
  ".cm-lsp-signature-tooltip": {
    padding: "6px 10px",
    "& .cm-lsp-signature": { fontFamily: mono, fontSize: "12px" },
    "& .cm-lsp-signature-num": { fontFamily: mono },
    "& .cm-lsp-active-parameter": {
      fontWeight: "600",
      color: "var(--tok-function)",
    },
  },

  ".cm-tooltip-lint": { padding: "4px" },
  ".cm-diagnostic": {
    padding: "4px 8px 4px 10px",
    marginLeft: "0",
    borderRadius: radius,
    lineHeight: "1.5",
  },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--destructive)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warning)" },
  ".cm-diagnostic-info, .cm-diagnostic-hint": {
    borderLeft: "3px solid var(--muted-foreground)",
  },
  ".cm-diagnosticSource": { color: "var(--muted-foreground)", opacity: "1" },
  ".cm-diagnosticAction": {
    color: "var(--primary-foreground)",
    backgroundColor: "var(--primary)",
    borderRadius: radius,
  },
  ".cm-lintRange-error": wavy("var(--destructive)"),
  ".cm-lintRange-warning": wavy("var(--warning)"),
  ".cm-lintRange-info, .cm-lintRange-hint": wavy("var(--muted-foreground)"),
  ".cm-lintRange-active": {
    backgroundColor: "color-mix(in oklch, var(--warning) 18%, transparent)",
  },
  ".cm-lintPoint:after": { borderBottomColor: "var(--destructive)" },
  ".cm-lintPoint-warning:after": { borderBottomColor: "var(--warning)" },
  ".cm-lintPoint-info:after, .cm-lintPoint-hint:after": {
    borderBottomColor: "var(--muted-foreground)",
  },

  // Unified diff (DiffView).
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "color-mix(in oklch, var(--success) 10%, transparent)",
  },
  "&.cm-merge-b .cm-changedText": {
    background: "color-mix(in oklch, var(--success) 28%, transparent)",
    borderRadius: "2px",
  },
  ".cm-deletedChunk": {
    backgroundColor: "color-mix(in oklch, var(--destructive) 9%, transparent)",
  },
  "&.cm-merge-b .cm-deletedText, .cm-deletedChunk .cm-deletedText": {
    background: "color-mix(in oklch, var(--destructive) 25%, transparent)",
    borderRadius: "2px",
  },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--success)" },
  ".cm-deletedLineGutter": { background: "var(--destructive)" },
  ".cm-collapsedLines": {
    color: "var(--muted-foreground)",
    background: "var(--muted)",
    fontFamily: sans,
    fontSize: "12px",
  },
});

function tag(name: string) {
  const found = typstHighlightTag[name];
  // Fails loudly if a language package update renames a class, instead of
  // silently dropping a color.
  if (!found) throw new Error(`codemirror-lang-typst has no tag for ${name}`);
  return found;
}

// Only classes: the colors live in editor.css next to their dark variants.
// Keyed by typst-syntax's class names, which is what the package exports.
const typstHighlight = HighlightStyle.define([
  { tag: tag("typ-comment"), class: "tok-comment" },
  { tag: tag("typ-punct"), class: "tok-punct" },
  { tag: tag("typ-math-group"), class: "tok-punct" },
  { tag: tag("typ-op"), class: "tok-operator" },
  { tag: tag("typ-escape"), class: "tok-escape" },
  { tag: tag("typ-strong"), class: "tok-strong" },
  { tag: tag("typ-emph"), class: "tok-emph" },
  { tag: tag("typ-link"), class: "tok-link" },
  { tag: tag("typ-raw"), class: "tok-raw" },
  { tag: tag("typ-heading"), class: "tok-heading" },
  { tag: tag("typ-marker"), class: "tok-marker" },
  { tag: tag("typ-math-delim"), class: "tok-math" },
  { tag: tag("typ-key"), class: "tok-keyword" },
  { tag: tag("typ-num"), class: "tok-number" },
  { tag: tag("typ-str"), class: "tok-string" },
  { tag: tag("typ-func"), class: "tok-function" },
  { tag: tag("typ-pol"), class: "tok-interp" },
  { tag: tag("typ-error"), class: "tok-invalid" },
]);

export const syntaxTheme: Extension = syntaxHighlighting(typstHighlight);

const chevron =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/** `markerDOM` for foldGutter: a chevron that turns when folded. */
export function foldMarker(open: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = `cm-foldMarker cm-foldMarker-${open ? "open" : "closed"}`;
  el.title = open ? "Fold" : "Unfold";
  el.innerHTML = chevron;
  return el;
}
