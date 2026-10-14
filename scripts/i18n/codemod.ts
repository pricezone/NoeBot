/**
 * Puts the English a person sees through a translation, file by file.
 *
 *     bun scripts/i18n/codemod.ts [--dry-run] [--report <file.json>] <files or folders…>
 *     bun scripts/i18n/codemod.ts --errors <files or folders…>
 *     bun scripts/i18n/codemod.ts --project desktop/tsconfig.json --module ./i18n <files…>
 *
 * `--project` names the TypeScript project the files belong to (the app's by default) and
 * `--module` where they import `useTranslation` and `i18n` from (`@/lib/i18n` by default): the
 * desktop launcher has its own translator with the same shape.
 *
 * `--errors` instead translates the message of every `new Error("…")` (and `Error("…")`) with
 * `i18n.t`, in `.ts` files too: a message thrown by a query or a mutation is what the screen shows.
 * Only for files whose errors a person reads; never for one whose errors are a tool's result.
 *
 * What it rewrites, each only where the text has a word in it:
 * - JSX text, merged with neighbouring `{value}`s into one sentence when every value is a string or a
 *   number to the type checker: `Hello {name}!` → `{t("Hello {{name}}!", { name })}`. A value that is
 *   an element, an icon or anything else ends the sentence there, so nothing is ever drawn as
 *   "[object Object]".
 * - `{"literal"}` children and literal text props (`title`, `aria-label`, `placeholder`…, see
 *   `TEXT_PROPS`), including template literals whose values are strings or numbers.
 * - `cond ? "A" : "B"` and `cond && "A"` in those places.
 *
 * Each rewritten component gets `const { t } = useTranslation("<namespace>")` as its first line (a
 * concise arrow body becomes a block), `t` joins the dependency array of any `useMemo`,
 * `useCallback` or effect it is used in, and the file imports `useTranslation` from `@/lib/i18n`.
 * The namespace follows the file's route chunk (`namespaceFor`).
 *
 * What it leaves for a person, and lists in the report: text in a function that is not a component
 * or a hook (no hook can be called there), a scope that already has another `t`, entities it cannot
 * decode, plurals written as ternaries, and English built in code. It never touches object
 * properties, so a tool's `description`, a prompt or a schema's `.describe()` stays English.
 *
 * Idempotent: `t("…")` is not English to it, so running it again changes nothing. That is what keeps
 * an upstream merge mechanical: take upstream's file and run this on it.
 */
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import ts from "typescript";
import { TEXT_PROPS } from "./scan";
import { ROOT } from "./source";

type Edit = { start: number; end: number; text: string };
type Note = { file: string; line: number; reason: string; text: string };

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const errorsMode = args.includes("--errors");
const flagValue = (flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const reportPath = flagValue("--report");
const projectPath = flagValue("--project") ?? "app/tsconfig.json";
const I18N_MODULE = flagValue("--module") ?? "@/lib/i18n";
const targets = args.filter(
  (arg, index) =>
    !arg.startsWith("--") &&
    !["--report", "--project", "--module"].includes(args[index - 1] ?? ""),
);

/** The namespace a file's words belong to: its route chunk's. See `src/lib/i18n/loaders.ts`. */
export function namespaceFor(file: string): string {
  if (file === "app/src/routes/sign.tsx") return "sign";
  if (
    file.startsWith("app/src/routes/_authed/_app/admin/") ||
    file.startsWith("app/src/components/admin/")
  )
    return "admin";
  if (
    file.startsWith("app/src/routes/_authed/_app/settings/") ||
    (file.startsWith("app/src/components/settings/") &&
      !file.endsWith("/settings-nav.ts"))
  )
    return "settings";
  return "common";
}

function expandTargets(): string[] {
  const files = new Set<string>();
  for (const target of targets) {
    const absolute = path.resolve(ROOT, target);
    if (statSync(absolute).isDirectory()) {
      for (const file of new Glob(
        errorsMode ? "**/*.{ts,tsx}" : "**/*.tsx",
      ).scanSync(absolute))
        if (!/\.test\.tsx?$/.test(file))
          files.add(path.relative(ROOT, path.join(absolute, file)));
    } else if (
      absolute.endsWith(".tsx") ||
      (errorsMode && absolute.endsWith(".ts"))
    ) {
      files.add(path.relative(ROOT, absolute));
    }
  }
  return [...files].sort();
}

const files = expandTargets();
if (!files.length) {
  console.error("Name the .tsx files or folders to rewrite.");
  process.exit(1);
}

const configPath = path.join(ROOT, projectPath);
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const compiler = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  path.dirname(configPath),
);
// The whole app project, not just the files rewritten: route data is typed through the generated
// route tree, which a program of the target files alone does not see, and reads as `any`.
const program = ts.createProgram({
  rootNames: [
    ...new Set([
      ...compiler.fileNames,
      ...files.map((file) => path.join(ROOT, file)),
    ]),
  ],
  options: compiler.options,
});
const checker = program.getTypeChecker();

const VERBATIM = new Set([
  "code",
  "kbd",
  "pre",
  "samp",
  "var",
  "style",
  "script",
]);
const WORDY = /\p{L}{2,}/u;
const HOOKS_WITH_DEPS = new Set([
  "useMemo",
  "useCallback",
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
]);
const COMPONENT_PROPERTIES = new Set([
  "component",
  "pendingComponent",
  "errorComponent",
  "notFoundComponent",
]);
const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  times: "×",
  rarr: "→",
  larr: "←",
  copy: "©",
};

function decodeEntities(text: string): string | undefined {
  let unknown = false;
  const decoded = text.replace(
    /&(#x?[0-9a-f]+|\w+);/gi,
    (match, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X"))
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith("#"))
        return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      const value = ENTITIES[name];
      if (value === undefined) unknown = true;
      return value ?? match;
    },
  );
  return unknown ? undefined : decoded;
}

/** The text React draws for a JSX text node: lines trimmed and joined with single spaces. */
function renderedJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = -1;
  lines.forEach((line, index) => {
    if (/[^ \t]/.test(line)) lastNonEmpty = index;
  });
  let result = "";
  lines.forEach((line, index) => {
    let trimmed = line.replace(/\t/g, " ");
    if (index !== 0) trimmed = trimmed.replace(/^ +/, "");
    if (index !== lines.length - 1) trimmed = trimmed.replace(/ +$/, "");
    if (trimmed) {
      if (index !== lastNonEmpty) trimmed += " ";
      result += trimmed;
    }
  });
  return result;
}

const TEXT = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike;
const NOTHING = ts.TypeFlags.Undefined | ts.TypeFlags.Null;

/** Text to the type checker: strings and numbers, possibly missing (drawn as nothing). */
function isTextType(expression: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(expression);
  const parts = type.isUnion() ? type.types : [type];
  return (
    parts.some((part) => (part.flags & TEXT) !== 0) &&
    parts.every((part) => (part.flags & (TEXT | NOTHING)) !== 0)
  );
}

/** Whether a value may be missing, so its placeholder needs `?? ""` rather than "undefined". */
function mayBeMissing(expression: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(expression);
  return (type.isUnion() ? type.types : [type]).some(
    (part) => (part.flags & NOTHING) !== 0,
  );
}

/** The source of a value as it goes into a sentence. */
function valueSource(expression: ts.Expression, source: ts.SourceFile): string {
  const text = expression.getText(source);
  return mayBeMissing(expression) ? `${text} ?? ""` : text;
}

/** A readable name for a value in a sentence: `name` for `user.name`, `query` for `query.trim()`. */
function placeholderName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    if (ts.isPropertyAccessExpression(callee))
      return placeholderName(callee.expression);
    if (ts.isIdentifier(callee)) return "value";
  }
  if (ts.isParenthesizedExpression(expression))
    return placeholderName(expression.expression);
  if (ts.isBinaryExpression(expression))
    return placeholderName(expression.left);
  return "value";
}

/** A `{value}` that can sit inside a sentence: text to the type checker, and not JSX. */
function sentenceValue(expression: ts.Expression): boolean {
  if (
    ts.isJsxElement(expression) ||
    ts.isJsxSelfClosingElement(expression) ||
    ts.isJsxFragment(expression) ||
    ts.isConditionalExpression(expression)
  )
    return false;
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken &&
    expression.operatorToken.kind !== ts.SyntaxKind.BarBarToken
  )
    return false;
  return isTextType(expression);
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  return undefined;
}

function nameOfFunction(fn: ts.SignatureDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
    let parent: ts.Node = fn.parent;
    while (
      ts.isCallExpression(parent) &&
      /^(memo|forwardRef|React\.memo|React\.forwardRef)$/.test(
        parent.expression.getText(),
      )
    )
      parent = parent.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
      return parent.name.text;
    if (
      ts.isPropertyAssignment(parent) &&
      ts.isIdentifier(parent.name) &&
      COMPONENT_PROPERTIES.has(parent.name.text)
    )
      return "Component";
    if (ts.isFunctionExpression(fn) && fn.name) return fn.name.text;
  }
  return undefined;
}

type Component =
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression;

function componentOf(node: ts.Node): Component | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      (ts.isArrowFunction(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent)) &&
      parent.body
    ) {
      const name = nameOfFunction(parent);
      if (name && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name)))
        return parent;
    }
  }
  return undefined;
}

/** The function between `node` and its component whose own scope declares a `t`, if any. */
function shadowsT(node: ts.Node, component: Component): boolean {
  const declaresT = (fn: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node) => {
      if (found) return;
      if (child !== fn && ts.isFunctionLike(child)) {
        // Parameters of nested functions only matter on the path, checked separately.
        return;
      }
      if (
        (ts.isVariableDeclaration(child) || ts.isParameter(child)) &&
        bindsT(child.name)
      )
        found = !isOwnHook(child);
      ts.forEachChild(child, visit);
    };
    if (ts.isFunctionLike(fn))
      for (const parameter of fn.parameters)
        if (bindsT(parameter.name)) return true;
    ts.forEachChild(fn, visit);
    return found;
  };
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent) && declaresT(parent)) return true;
    if (parent === component) break;
  }
  return false;
}

function bindsT(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) return name.text === "t";
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsT(element.name),
  );
}

function isOwnHook(declaration: ts.Node): boolean {
  return (
    ts.isVariableDeclaration(declaration) &&
    !!declaration.initializer &&
    ts.isCallExpression(declaration.initializer) &&
    declaration.initializer.expression.getText() === "useTranslation"
  );
}

function existingHook(component: Component): boolean {
  if (!component.body || !ts.isBlock(component.body)) return false;
  return component.body.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(isOwnHook),
  );
}

const notes: Note[] = [];
let changedFiles = 0;
let rewrites = 0;

for (const file of files) {
  const absolute = path.join(ROOT, file);
  const source = program.getSourceFile(absolute);
  if (!source) continue;
  const text = source.text;
  const namespace = namespaceFor(file);
  const edits: Edit[] = [];
  const components = new Set<Component>();
  const depsCalls = new Set<ts.CallExpression>();
  const line = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const note = (node: ts.Node, reason: string, snippet?: string) =>
    notes.push({
      file,
      line: line(node),
      reason,
      text: (snippet ?? node.getText(source)).slice(0, 120),
    });

  const ignored = (node: ts.Node) => {
    const lines = text.split("\n");
    const at = line(node);
    return [lines[at - 2], lines[at - 1]].some((value) =>
      value?.includes("i18n-ignore"),
    );
  };
  const verbatim = (node: ts.Node) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (
        ts.isJsxElement(parent) &&
        VERBATIM.has(parent.openingElement.tagName.getText(source))
      )
        return true;
    return false;
  };

  /** Where `t` may be used for `node`: its component, or undefined with a note why not. */
  const hostFor = (node: ts.Node, snippet: string): Component | undefined => {
    const component = componentOf(node);
    if (!component) {
      note(node, "not inside a component or hook", snippet);
      return undefined;
    }
    if (shadowsT(node, component)) {
      note(node, "another `t` is in scope", snippet);
      return undefined;
    }
    return component;
  };

  const useHost = (node: ts.Node, component: Component) => {
    components.add(component);
    for (
      let parent = node.parent;
      parent && parent !== component;
      parent = parent.parent
    ) {
      if (
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        HOOKS_WITH_DEPS.has(parent.expression.text)
      )
        depsCalls.add(parent);
    }
    rewrites += 1;
  };

  const call = (key: string, values: [string, string][]) => {
    const object = values.length
      ? `, { ${values
          .map(([name, value]) => (name === value ? name : `${name}: ${value}`))
          .join(", ")} }`
      : "";
    return `t(${JSON.stringify(key)}${object})`;
  };

  /** A run of JSX children: text and string-valued `{values}`, as one sentence. */
  const rewriteRun = (run: ts.JsxChild[]) => {
    if (!run.some((child) => ts.isJsxText(child) && WORDY.test(child.text)))
      return;
    const first = run[0] as ts.JsxChild;
    const last = run[run.length - 1] as ts.JsxChild;
    if (run.some((child) => ignored(child) || verbatim(child))) return;
    let rendered = "";
    const values: [string, string][] = [];
    for (const child of run) {
      if (ts.isJsxText(child)) {
        const decoded = decodeEntities(renderedJsxText(child.text));
        if (decoded === undefined) {
          note(child, "an entity the codemod cannot decode");
          return;
        }
        rendered += decoded;
      } else if (ts.isJsxExpression(child) && child.expression) {
        const literal = literalText(child.expression);
        if (literal !== undefined) {
          rendered += literal;
          continue;
        }
        let name = placeholderName(child.expression);
        const value = valueSource(child.expression, source);
        const taken = values.find(([existing]) => existing === name);
        if (taken && taken[1] !== value) {
          let suffix = 2;
          while (values.some(([existing]) => existing === `${name}${suffix}`))
            suffix += 1;
          name = `${name}${suffix}`;
        }
        if (!values.some(([existing]) => existing === name))
          values.push([name, value]);
        rendered += `{{${name}}}`;
      }
    }
    const key = rendered.trim();
    if (!WORDY.test(key.replace(/\{\{[^}]*\}\}/g, ""))) return;
    const component = hostFor(first, rendered);
    if (!component) return;
    const lead = rendered.startsWith(" ") ? '{" "}' : "";
    const trail = rendered.endsWith(" ") ? '{" "}' : "";
    edits.push({
      start: first.getStart(source),
      end: last.getEnd(),
      text: `${lead}{${call(key, values)}}${trail}`,
    });
    useHost(first, component);
  };

  const visitChildren = (children: ts.NodeArray<ts.JsxChild>) => {
    let run: ts.JsxChild[] = [];
    const flush = () => {
      // Whitespace-only text at the edges of a run belongs to the layout, not to the sentence.
      while (
        run.length &&
        ts.isJsxText(run[0] as ts.JsxChild) &&
        !/\S/.test((run[0] as ts.JsxText).text)
      )
        run.shift();
      while (
        run.length &&
        ts.isJsxText(run[run.length - 1] as ts.JsxChild) &&
        !/\S/.test((run[run.length - 1] as ts.JsxText).text)
      )
        run.pop();
      if (run.length) rewriteRun(run);
      run = [];
    };
    // A sentence an element sits in the middle of ("Read the <a>docs</a> now") reads as two keys
    // here; it wants one `<Trans>`, which is a person's call (which element, which tag name).
    const wordyText = children.filter(
      (child) => ts.isJsxText(child) && WORDY.test(child.text),
    );
    const elementBetween = children.some(
      (child, index) =>
        (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) &&
        children.slice(0, index).some((before) => wordyText.includes(before)) &&
        children.slice(index + 1).some((after) => wordyText.includes(after)),
    );
    if (elementBetween && children[0])
      note(
        children[0].parent,
        "a sentence split by an element: consider <Trans>",
        children
          .map((child) => child.getText(source))
          .join("")
          .replace(/\s+/g, " "),
      );
    for (const child of children) {
      if (ts.isJsxText(child)) {
        run.push(child);
        continue;
      }
      if (ts.isJsxExpression(child) && child.expression) {
        const expression = child.expression;
        if (literalText(expression) !== undefined) {
          run.push(child);
          continue;
        }
        if (sentenceValue(expression)) {
          run.push(child);
          continue;
        }
      }
      flush();
    }
    flush();
  };

  const rewriteLiteral = (literal: ts.Expression, inJsxAttribute: boolean) => {
    const value = literalText(literal);
    if (value === undefined || !WORDY.test(value)) return;
    if (ignored(literal) || verbatim(literal)) return;
    const component = hostFor(literal, value);
    if (!component) return;
    const replacement = call(value, []);
    edits.push({
      start: literal.getStart(source),
      end: literal.getEnd(),
      text: inJsxAttribute ? `{${replacement}}` : replacement,
    });
    useHost(literal, component);
  };

  const rewriteTemplate = (template: ts.TemplateExpression, wrap: boolean) => {
    let key = template.head.text;
    const values: [string, string][] = [];
    for (const span of template.templateSpans) {
      if (!sentenceValue(span.expression)) {
        note(template, "a template with a value that is not plain text");
        return;
      }
      const name = placeholderName(span.expression);
      if (!values.some(([existing]) => existing === name))
        values.push([name, valueSource(span.expression, source)]);
      key += `{{${name}}}${span.literal.text}`;
    }
    if (!WORDY.test(key.replace(/\{\{[^}]*\}\}/g, "")) || ignored(template))
      return;
    const component = hostFor(template, key);
    if (!component) return;
    edits.push({
      start: template.getStart(source),
      end: template.getEnd(),
      text: wrap ? `{${call(key, values)}}` : call(key, values),
    });
    useHost(template, component);
  };

  /** `cond ? "A" : "B"` and `cond && "A"`, branch by branch. */
  const rewriteChoices = (expression: ts.Expression) => {
    if (ts.isParenthesizedExpression(expression))
      return rewriteChoices(expression.expression);
    if (ts.isConditionalExpression(expression)) {
      for (const branch of [expression.whenTrue, expression.whenFalse]) {
        if (literalText(branch) !== undefined) rewriteLiteral(branch, false);
        else if (ts.isTemplateExpression(branch))
          rewriteTemplate(branch, false);
        else rewriteChoices(branch);
      }
    } else if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind ===
        ts.SyntaxKind.AmpersandAmpersandToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      if (literalText(expression.right) !== undefined)
        rewriteLiteral(expression.right, false);
    }
  };

  if (errorsMode) {
    const visitErrors = (node: ts.Node) => {
      if (
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Error"
      ) {
        const message = node.arguments?.[0];
        const literal = literalText(message);
        if (
          message &&
          literal !== undefined &&
          WORDY.test(literal) &&
          !ignored(message)
        ) {
          edits.push({
            start: message.getStart(source),
            end: message.getEnd(),
            text: `i18n.t(${JSON.stringify(literal)})`,
          });
          rewrites += 1;
        } else if (
          message &&
          ts.isTemplateExpression(message) &&
          !ignored(message)
        ) {
          let key = message.head.text;
          const values: [string, string][] = [];
          let plain = true;
          for (const span of message.templateSpans) {
            if (!sentenceValue(span.expression)) {
              plain = false;
              break;
            }
            const name = placeholderName(span.expression);
            if (!values.some(([existing]) => existing === name))
              values.push([name, valueSource(span.expression, source)]);
            key += `{{${name}}}${span.literal.text}`;
          }
          if (!plain)
            note(
              message,
              "an error message with a value that is not plain text",
            );
          else if (WORDY.test(key)) {
            edits.push({
              start: message.getStart(source),
              end: message.getEnd(),
              text: `i18n.t(${JSON.stringify(key)}, { ${values
                .map(([name, value]) =>
                  name === value ? name : `${name}: ${value}`,
                )
                .join(", ")} })`,
            });
            rewrites += 1;
          }
        }
      }
      ts.forEachChild(node, visitErrors);
    };
    visitErrors(source);
    if (!edits.length) continue;
    const fromI18nModule = source.statements.find(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === I18N_MODULE,
    );
    const namedImports = fromI18nModule?.importClause?.namedBindings;
    if (fromI18nModule && namedImports && ts.isNamedImports(namedImports)) {
      if (
        !namedImports.elements.some((element) => element.name.text === "i18n")
      ) {
        const at =
          namedImports.elements[0]?.getStart(source) ??
          namedImports.getStart(source) + 1;
        edits.push({ start: at, end: at, text: "i18n, " });
      }
    } else {
      const imports = source.statements.filter(ts.isImportDeclaration);
      const at = imports.length
        ? (imports[imports.length - 1] as ts.Node).getEnd()
        : 0;
      edits.push({
        start: at,
        end: at,
        text: `${at ? "\n" : ""}import { i18n } from "${I18N_MODULE}";${at ? "" : "\n"}`,
      });
    }
    let output = text;
    for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
      output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
    changedFiles += 1;
    if (!dryRun) writeFileSync(absolute, output);
    continue;
  }

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      visitChildren(node.children);
      for (const child of node.children)
        if (ts.isJsxExpression(child) && child.expression)
          rewriteChoices(child.expression);
    }
    if (ts.isJsxAttribute(node) && TEXT_PROPS.has(node.name.getText(source))) {
      const value = node.initializer;
      if (value && ts.isStringLiteral(value)) rewriteLiteral(value, true);
      else if (value && ts.isJsxExpression(value) && value.expression) {
        const expression = value.expression;
        if (literalText(expression) !== undefined)
          rewriteLiteral(expression, false);
        else if (ts.isTemplateExpression(expression))
          rewriteTemplate(expression, false);
        else rewriteChoices(expression);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!edits.length) continue;

  // The hook, at the top of each component that now translates.
  for (const component of components) {
    if (existingHook(component)) continue;
    const hook = `const { t } = useTranslation(${
      namespace === "common" ? "" : JSON.stringify(namespace)
    });`;
    const body = component.body as ts.ConciseBody;
    if (ts.isBlock(body)) {
      edits.push({
        start: body.getStart(source) + 1,
        end: body.getStart(source) + 1,
        text: `\n${hook}`,
      });
    } else {
      edits.push({
        start: body.getStart(source),
        end: body.getStart(source),
        text: `{\n${hook}\nreturn `,
      });
      edits.push({ start: body.getEnd(), end: body.getEnd(), text: ";\n}" });
    }
  }
  for (const hook of depsCalls) {
    const deps = hook.arguments[1];
    if (!deps || !ts.isArrayLiteralExpression(deps)) continue;
    if (deps.elements.some((element) => element.getText(source) === "t"))
      continue;
    const at = deps.getStart(source) + 1;
    edits.push({
      start: at,
      end: at,
      text: deps.elements.length ? "t, " : "t",
    });
  }

  // The import.
  const fromI18n = source.statements.find(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === I18N_MODULE,
  );
  const named = fromI18n?.importClause?.namedBindings;
  if (fromI18n && named && ts.isNamedImports(named)) {
    if (
      !named.elements.some((element) => element.name.text === "useTranslation")
    ) {
      const at =
        named.elements[named.elements.length - 1]?.getEnd() ??
        named.getStart(source) + 1;
      edits.push({ start: at, end: at, text: ", useTranslation" });
    }
  } else {
    const imports = source.statements.filter(ts.isImportDeclaration);
    const at = imports.length
      ? (imports[imports.length - 1] as ts.Node).getEnd()
      : 0;
    edits.push({
      start: at,
      end: at,
      // After the last import, or first thing in a file that had none, ahead of its doc comment.
      text: at
        ? `\nimport { useTranslation } from "${I18N_MODULE}";`
        : `import { useTranslation } from "${I18N_MODULE}";\n\n`,
    });
  }

  let output = text;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);

  const reparsed = ts.createSourceFile(
    file,
    output,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const diagnostics =
    (reparsed as unknown as { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  if (diagnostics.length) {
    notes.push({
      file,
      line: 0,
      reason: "the rewrite did not parse; left unchanged",
      text: ts.flattenDiagnosticMessageText(
        diagnostics[0]?.messageText ?? "",
        " ",
      ),
    });
    continue;
  }
  changedFiles += 1;
  if (!dryRun) writeFileSync(absolute, output);
}

console.log(
  `${rewrites} rewrites in ${changedFiles} files${dryRun ? " (dry run)" : ""}; ${notes.length} left for a person`,
);
if (reportPath)
  writeFileSync(reportPath, `${JSON.stringify(notes, null, 2)}\n`);
else
  for (const item of notes)
    console.log(`${item.file}:${item.line}\t${item.reason}\t${item.text}`);
