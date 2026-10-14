import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import ts from "typescript";
import { type FoundKey, parse } from "./scan";

/**
 * The sentences the server sends that a person may read, read out of `server/src` without running
 * it, as keys of the `server` namespace.
 *
 * The server stays English: it answers the model as well as people, and its tests read its words.
 * The app translates a sentence where it shows it (`localizeServerMessage`), by exact match against
 * these keys. A sentence built with `${…}` becomes a pattern, `{{0}}` for the first value and so
 * on, which the app matches with the values put back in.
 *
 * What counts as a sentence a person may read:
 * - the value of an `error`, `message` or `reason` property, the shape every route answers in;
 * - the message of a refusal (`new …RefusedError(…)`, `…RefusalError`) or of the few other errors
 *   routes turn into those bodies. A plain `new Error(…)` is an invariant or a startup failure an
 *   operator reads in the logs, and is left English.
 *
 * Files only an operator's terminal reads (configuration, the tenant packager, migrations) are not
 * scanned.
 *
 * Both must read as prose: two words or more with letters in them. A code such as `not_found` is
 * a value the app compares, never a sentence, and is left alone.
 */

const SENTENCE_PROPERTIES = new Set(["error", "message", "reason"]);

/** Errors whose message a route sends as it is, besides the refusals. */
const SENT_ERRORS = new Set([
  "VoiceSessionError",
  "VoiceError",
  "DeliveryProviderError",
  "DecisionConflictError",
  "DecisionAnswerError",
  "EndpointNotAllowedError",
  "ComputerStoppedError",
]);

const sentError = (name: string) =>
  /Refus(ed|al)Error$/.test(name) || SENT_ERRORS.has(name);

/**
 * Words the server keeps for a screen to show as they are, not as an error: a file and the
 * properties whose values are such words, every one of them, a short label included.
 */
const DISPLAY_LABELS: Record<string, Set<string>> = {
  "server/src/admin/capabilities.ts": new Set(["title", "description"]),
};

/** Read in an operator's terminal, never on a screen. */
const OPERATOR_ONLY = [
  /^server\/src\/config\.ts$/,
  /^server\/src\/tenant-package\.ts$/,
  /^server\/src\/production-entry\.ts$/,
  /^server\/src\/db\//,
];

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** The key for a literal or template: `{{0}}`, `{{1}}`… where values go. */
function keyOf(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node)) {
    let key = node.head.text;
    node.templateSpans.forEach((span, index) => {
      key += `{{${index}}}${span.literal.text}`;
    });
    return key;
  }
  if (ts.isParenthesizedExpression(node)) return keyOf(node.expression);
  return undefined;
}

/** Every literal a value may be: both sides of a ternary, either side of `??` or `||`. */
function keysOf(node: ts.Expression): string[] {
  if (ts.isConditionalExpression(node))
    return [...keysOf(node.whenTrue), ...keysOf(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  )
    return [...keysOf(node.left), ...keysOf(node.right)];
  const key = keyOf(node);
  return key === undefined ? [] : [key];
}

export function isSentence(text: string): boolean {
  // A lowercase phrase with no full stop is a clause another sentence or a log line is built from.
  if (/^\p{Ll}/u.test(text) && !/[.?!]$/.test(text)) return false;
  const words = text
    .replace(/\{\{\d+\}\}/g, " ")
    .split(/\s+/)
    .filter((word) => /\p{L}{2,}/u.test(word));
  return words.length >= 2;
}

export function serverSentencesIn(
  file: string,
  source: ts.SourceFile,
): FoundKey[] {
  const found: FoundKey[] = [];
  const add = (node: ts.Expression) => {
    for (const key of keysOf(node)) {
      if (!isSentence(key)) continue;
      found.push({
        key,
        namespace: "server",
        plural: false,
        file,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
  };
  const labels = DISPLAY_LABELS[file];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      SENTENCE_PROPERTIES.has(propertyName(node.name) ?? "")
    )
      add(node.initializer);
    if (
      labels &&
      ts.isPropertyAssignment(node) &&
      labels.has(propertyName(node.name) ?? "")
    )
      for (const key of keysOf(node.initializer))
        if (/\p{L}{2,}/u.test(key))
          found.push({
            key,
            namespace: "server",
            plural: false,
            file,
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
          });
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      sentError(node.expression.text) &&
      node.arguments?.[0]
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every `server/src` file a sentence could come from: not tests, not the operator's. */
export function serverSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const file of new Glob("server/src/**/*.ts").scanSync(root)) {
    if (
      /\.test\.ts$/.test(file) ||
      OPERATOR_ONLY.some((pattern) => pattern.test(file))
    )
      continue;
    files.push(file);
  }
  return files.sort();
}

export function scanServer(root: string): FoundKey[] {
  return serverSourceFiles(root).flatMap((file) =>
    serverSentencesIn(
      file,
      parse(file, readFileSync(path.join(root, file), "utf8")),
    ),
  );
}
