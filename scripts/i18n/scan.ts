import ts from "typescript";

/**
 * Reads translation keys and untranslated English out of the app's source, without running it.
 *
 * Two readers over one parse:
 * - `keysIn` finds every key the code asks for: `t("…")`, `i18n.t("…")`, `<Trans i18nKey="…">` and
 *   `msg("…")`, with the namespace it will be looked up in and whether it is a plural or has a
 *   context. `extract.ts` writes them to `app/src/locales/manifest.json`, which the catalog tests
 *   hold the Greek to.
 * - `untranslatedIn` finds English a person would see that is not going through a translation:
 *   JSX text and the text props (`title`, `aria-label`, `placeholder`…). `guard.ts` counts them per
 *   file, and the ratchet test refuses any file that gains one.
 *
 * The namespace of a `t` is the one its component asked `useTranslation` for, "common" when it asked
 * for none, the `ns` option when the call names one, and for `msg` constants (translated wherever
 * they are drawn) "common".
 */

export type FoundKey = {
  key: string;
  namespace: string;
  plural: boolean;
  context?: string;
  file: string;
  line: number;
};

export type Untranslated = {
  file: string;
  line: number;
  text: string;
  where: string;
};

const DEFAULT_NAMESPACE = "common";

/** Props whose string value a person reads or hears. */
export const TEXT_PROPS = new Set([
  "title",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "placeholder",
  "alt",
  "label",
  "description",
  "tooltip",
  "heading",
  "emptyText",
  "submitLabel",
  "cancelLabel",
  "confirmLabel",
  // This app's own components' text props, found by counting the props that carry English.
  "subtitle",
  "empty",
  "caption",
  "secondary",
  "detail",
]);

export function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  return undefined;
}

function objectProperty(
  node: ts.Node | undefined,
  name: string,
): ts.Expression | undefined {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  for (const property of node.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    )
      return property.initializer;
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === name
    )
      return property.name;
  }
  return undefined;
}

/** The namespace the nearest enclosing function asked `useTranslation` for. */
function namespaceInScope(node: ts.Node): string {
  for (let scope: ts.Node | undefined = node; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope)) continue;
    let found: string | undefined;
    const visit = (child: ts.Node) => {
      if (found !== undefined) return;
      if (child !== scope && ts.isFunctionLike(child)) return;
      if (
        ts.isCallExpression(child) &&
        ts.isIdentifier(child.expression) &&
        child.expression.text === "useTranslation"
      ) {
        found = literalText(child.arguments[0]) ?? DEFAULT_NAMESPACE;
        return;
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(scope, visit);
    if (found !== undefined) return found;
  }
  return DEFAULT_NAMESPACE;
}

function isTranslateCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "t";
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "t" &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === "i18n" || callee.expression.text === "t")
  );
}

export function keysIn(file: string, source: ts.SourceFile): FoundKey[] {
  const keys: FoundKey[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (isTranslateCall(node)) {
        const key = literalText(node.arguments[0]);
        if (key !== undefined) {
          const options = node.arguments[1];
          const explicit = literalText(objectProperty(options, "ns"));
          keys.push({
            key,
            namespace:
              explicit ??
              (ts.isIdentifier(callee)
                ? namespaceInScope(node)
                : DEFAULT_NAMESPACE),
            plural: objectProperty(options, "count") !== undefined,
            context: literalText(objectProperty(options, "context")),
            file,
            line: lineOf(source, node),
          });
        }
      } else if (ts.isIdentifier(callee) && callee.text === "withTimeout") {
        // `withTimeout(ms, "message")` says its message through `i18n.t`.
        const key = literalText(node.arguments[1]);
        if (key !== undefined)
          keys.push({
            key,
            namespace: DEFAULT_NAMESPACE,
            plural: false,
            file,
            line: lineOf(source, node),
          });
      } else if (ts.isIdentifier(callee) && callee.text === "msg") {
        const key = literalText(node.arguments[0]);
        if (key !== undefined)
          keys.push({
            key,
            namespace: DEFAULT_NAMESPACE,
            plural: false,
            file,
            line: lineOf(source, node),
          });
      }
    }
    // `client(…, { fallback: "…" })`: what a person reads when the server says nothing, translated
    // by `client` itself.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "fallback"
    ) {
      const key = literalText(node.initializer);
      if (key !== undefined)
        keys.push({
          key,
          namespace: DEFAULT_NAMESPACE,
          plural: false,
          file,
          line: lineOf(source, node),
        });
    }
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(source) === "Trans"
    ) {
      const attribute = (name: string) =>
        node.attributes.properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) &&
            property.name.getText(source) === name,
        )?.initializer;
      const key = literalText(attribute("i18nKey"));
      if (key !== undefined)
        keys.push({
          key,
          namespace: literalText(attribute("ns")) ?? namespaceInScope(node),
          plural: attribute("count") !== undefined,
          file,
          line: lineOf(source, node),
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}

/** Elements whose text is code or data, never prose to translate. */
const VERBATIM_ELEMENTS = new Set([
  "code",
  "kbd",
  "pre",
  "samp",
  "var",
  "style",
  "script",
]);

function ignored(source: ts.SourceFile, node: ts.Node): boolean {
  // `// i18n-ignore` (or `{/* i18n-ignore */}`) on the line before, on any line the node spans (a
  // formatter may wrap a long attribute value onto its own lines), or at the end of its last line.
  const first = lineOf(source, node);
  const last = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const lines = source.text.split("\n");
  return lines
    .slice(Math.max(0, first - 2), last)
    .some((text) => text.includes("i18n-ignore"));
}

function insideVerbatim(node: ts.Node, source: ts.SourceFile): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent)) {
      const tag = parent.openingElement.tagName.getText(source);
      if (VERBATIM_ELEMENTS.has(tag)) return true;
    }
  }
  return false;
}

/** Text with at least one word: two letters in a row, in any script. */
const WORDY = /\p{L}{2,}/u;

export function untranslatedIn(
  file: string,
  source: ts.SourceFile,
): Untranslated[] {
  const found: Untranslated[] = [];
  const add = (node: ts.Node, text: string, where: string) => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    // Words, not the names of values: `${bot.name}: ${status}` has none of its own.
    if (!WORDY.test(trimmed.replace(/\$\{[^}]*\}|\{\{[^}]*\}\}/g, ""))) return;
    if (ignored(source, node) || insideVerbatim(node, source)) return;
    found.push({ file, line: lineOf(source, node), text: trimmed, where });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node, node.text, "text");
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (TEXT_PROPS.has(name)) {
        const value = node.initializer;
        const text =
          literalText(value) ??
          (value && ts.isJsxExpression(value)
            ? (literalText(value.expression) ??
              (value.expression && ts.isTemplateExpression(value.expression)
                ? value.expression.getText(source).slice(1, -1)
                : undefined))
            : undefined);
        if (text !== undefined) add(node, text, name);
      }
    }
    if (
      ts.isJsxExpression(node) &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      const text =
        literalText(node.expression) ??
        // `{`${count} connected`}`: a sentence built in place is still words on the screen.
        (node.expression && ts.isTemplateExpression(node.expression)
          ? node.expression.getText(source).slice(1, -1)
          : undefined);
      if (text !== undefined) add(node, text, "text");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
