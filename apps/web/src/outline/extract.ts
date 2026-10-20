import { parser } from "codemirror-lang-typst";

// @lezer/common is only a transitive dependency, so the type comes from here.
type SyntaxNode = ReturnType<typeof parser.parse>["topNode"];

export interface OutlineItem {
  kind: "heading" | "figure" | "include";
  /** Heading depth (the number of `=`); 0 for figures and includes. */
  level: number;
  /** Heading text, figure caption or include path. May be empty. */
  title: string;
  label?: string;
  /** UTF-16 offsets of the node, as CodeMirror positions them. */
  from: number;
  to: number;
}

// Nodes whose source text is part of the readable title as it stands.
const VERBATIM = new Set([
  "Text",
  "Escape",
  "Shorthand",
  "SmartQuote",
  "Link",
  "Ref",
  "Equation",
]);
// Markup syntax that only frames the text it surrounds.
const SKIPPED = new Set([
  "LineComment",
  "BlockComment",
  "RawDelim",
  "RawLang",
  "RawTrimmed",
]);

function plainText(node: SyntaxNode, source: string): string {
  let out = "";
  const visit = (n: SyntaxNode) => {
    if (SKIPPED.has(n.name)) return;
    if (VERBATIM.has(n.name)) out += source.slice(n.from, n.to);
    else if (n.name === "Space" || n.name === "Linebreak") out += " ";
    else for (let c = n.firstChild; c; c = c.nextSibling) visit(c);
  };
  visit(node);
  return out.replace(/\s+/g, " ").trim();
}

function unquote(str: string): string {
  return str
    .slice(1, str.endsWith('"') && str.length > 1 ? -1 : undefined)
    .replace(/\\(.)/g, "$1");
}

/** The label that follows `node` on the same paragraph, if any. */
function trailingLabel(node: SyntaxNode, source: string): string | undefined {
  let next = node.nextSibling;
  // A blank line (Parbreak) detaches a label; plain spaces do not.
  while (next?.name === "Space") next = next.nextSibling;
  if (next?.name !== "Label") return undefined;
  return source.slice(next.from + 1, next.to - 1);
}

function captionOf(call: SyntaxNode, source: string): string {
  const args = call.getChild("Args");
  for (let a = args?.firstChild ?? null; a; a = a.nextSibling) {
    if (a.name !== "Named" || a.getChild("Ident") === null) continue;
    const key = a.firstChild;
    if (!key || source.slice(key.from, key.to) !== "caption") continue;
    for (let v = key.nextSibling; v; v = v.nextSibling) {
      if (v.name === "ContentBlock") return plainText(v, source);
      if (v.name === "Str") return unquote(source.slice(v.from, v.to));
    }
  }
  return "";
}

function isFigureCall(node: SyntaxNode, source: string): boolean {
  const callee = node.firstChild;
  return (
    callee?.name === "Ident" &&
    source.slice(callee.from, callee.to) === "figure"
  );
}

/**
 * Headings, figures and includes of a Typst source, in document order. The
 * parser recovers from errors, so half-typed input still yields what could be
 * read instead of throwing.
 */
export function extractOutline(source: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  parser.parse(source).iterate({
    enter(ref) {
      const node = ref.node;
      switch (node.name) {
        case "Heading": {
          const marker = node.getChild("HeadingMarker");
          const body = node.getChild("Markup");
          items.push({
            kind: "heading",
            level: marker ? marker.to - marker.from : 1,
            title: body ? plainText(body, source) : "",
            label: trailingLabel(node, source),
            from: node.from,
            to: node.to,
          });
          break;
        }
        case "FuncCall":
          if (isFigureCall(node, source))
            items.push({
              kind: "figure",
              level: 0,
              title: captionOf(node, source),
              label: trailingLabel(node, source),
              from: node.from,
              to: node.to,
            });
          break;
        case "ModuleInclude": {
          // Only a literal path can be followed; computed ones are skipped.
          const path = node.getChild("Str");
          if (path)
            items.push({
              kind: "include",
              level: 0,
              title: unquote(source.slice(path.from, path.to)),
              from: node.from,
              to: node.to,
            });
          break;
        }
      }
    },
  });
  return items;
}
