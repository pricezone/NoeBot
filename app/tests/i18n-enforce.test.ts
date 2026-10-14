import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse } from "../../scripts/i18n/scan";
import { appSourceFiles, ROOT, scanApp } from "../../scripts/i18n/source";

/**
 * The whole app is translated, and stays so.
 *
 * Before this, files were held to it one at a time (`translated.json`). Now every file is: English a
 * person would see that does not go through a translation fails here, wherever it is added — by
 * hand, by a new feature, or by a merge from upstream OpenBot. Mark code or data that only looks
 * like prose with `// i18n-ignore`.
 *
 * And dates, numbers and sorted names follow the interface's language: a bare `toLocaleString()`
 * formats in the browser's language, which put Greek dates inside English sentences, and a bare
 * `localeCompare` sorts the way the browser does rather than the way the reader reads. They go
 * through `intlLocale()` and `compareText()` (`src/lib/i18n/format.ts`); a comparison of
 * identifiers or timestamps says so with `// i18n-ignore`.
 */

const { untranslated } = scanApp();

test("no English a person would see goes untranslated, in any file", () => {
  expect(
    [...untranslated].flatMap(([file, hits]) =>
      hits.map((hit) => `${file}:${hit.line} ${hit.where}: ${hit.text}`),
    ),
  ).toEqual([]);
});

describe("formatting follows the interface's language", () => {
  const lines = appSourceFiles().flatMap((file) =>
    readFileSync(path.join(ROOT, file), "utf8")
      .split("\n")
      .map((text, index, all) => ({
        where: `${file}:${index + 1}`,
        text,
        ignored: [all[index - 1], text].some((line) =>
          line?.includes("i18n-ignore"),
        ),
      })),
  );

  test("no date or number is formatted in the browser's language", () => {
    expect(
      lines
        .filter(
          ({ text, ignored }) =>
            !ignored &&
            /\.toLocale(String|DateString|TimeString)\(\s*(\)|undefined\b)/.test(
              text,
            ),
        )
        .map(({ where, text }) => `${where} ${text.trim()}`),
    ).toEqual([]);
  });

  test("no list a person reads is sorted the browser's way", () => {
    expect(
      lines
        .filter(
          ({ text, ignored }) => !ignored && /\.localeCompare\(/.test(text),
        )
        .map(({ where, text }) => `${where} ${text.trim()}`),
    ).toEqual([]);
  });
});

/**
 * A label kept in a map, `{ label: "Details" }`, is drawn later by `{TABS[id].label}`, where neither
 * the guard nor the type checker sees English. That holds for a module-level constant and for a
 * list a component builds (`sections = [{ title: "Connected", … }]`) alike. Such a label says it is
 * a key with `msg("…")` and is drawn with `t(…)`, or is translated where it is built; a name kept as
 * it is (`glossary.json`'s `keep`) needs neither. Calls are left out, the model-facing tool
 * definitions among them, except the ones that only wrap a component or a value. The gallery's
 * components are left out too: their titles and descriptions are what the model reads, and their
 * samples are data.
 */
test("a label kept in a map is marked as a key", () => {
  const keep = new Set(
    (
      JSON.parse(
        readFileSync(path.join(ROOT, "docs/i18n/glossary.json"), "utf8"),
      ) as { keep: string[] }
    ).keep,
  );
  const NAMES = new Set([
    "label",
    "title",
    "description",
    "name",
    "summary",
    "heading",
    "caption",
    "text",
  ]);
  const PROSE = /^[A-Z][a-z’']+(?:[ -][A-Za-z’'.,&()—]+)*[.…?!]?$/;
  const WRAPPERS = new Set([
    "memo",
    "forwardRef",
    "useMemo",
    "useCallback",
    "useState",
  ]);
  const found: string[] = [];
  for (const file of appSourceFiles()) {
    if (file.startsWith("app/src/components/gallery/")) continue;
    const source = parse(file, readFileSync(path.join(ROOT, file), "utf8"));
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        !(
          ts.isIdentifier(node.expression) && WRAPPERS.has(node.expression.text)
        )
      )
        return;
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        NAMES.has(node.name.text) &&
        (ts.isStringLiteral(node.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(node.initializer)) &&
        PROSE.test(node.initializer.text) &&
        !keep.has(node.initializer.text)
      ) {
        const line =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        found.push(`${file}:${line} ${node.initializer.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(found).toEqual([]);
});
