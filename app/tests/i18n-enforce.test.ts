import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
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
