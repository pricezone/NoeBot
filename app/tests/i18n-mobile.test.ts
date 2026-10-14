import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import { keysIn, parse, untranslatedIn } from "../../scripts/i18n/scan";
import { ROOT } from "../../scripts/i18n/source";

/**
 * The mobile app's Greek, held to what its source asks for, and the files it keeps copies of held
 * to their originals. `mobile/` is its own package and cannot import the app's or the shared code,
 * so it carries copies; a copy that drifts is a language list, a schedule or a sentence that says
 * one thing on the phone and another on the web.
 */

const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const COPIES: [copy: string, original: string][] = [
  ["mobile/src/i18n/locales.ts", "shared/i18n/locales.ts"],
  ["mobile/src/i18n/schedule-words.ts", "shared/i18n/schedule-words.ts"],
  ["mobile/src/i18n/server.el.json", "app/src/locales/el/server.json"],
  ["mobile/src/i18n/content.el.json", "app/src/locales/el/content.json"],
];

describe("mobile copies", () => {
  for (const [copy, original] of COPIES)
    test(`${copy} is ${original}, byte for byte`, () => {
      expect(read(copy)).toBe(read(original));
    });
});

const files = [
  ...new Glob("mobile/{app,src}/**/*.{ts,tsx}").scanSync(ROOT),
].sort();
const sources = files.map((file) => ({
  file,
  source: parse(file, read(file)),
}));
const keys = sources.flatMap(({ file, source }) => keysIn(file, source));
const greek = JSON.parse(read("mobile/src/i18n/el.json")) as Record<
  string,
  string
>;

describe("mobile Greek", () => {
  test("covers every key the app asks for", () => {
    const missing = keys.flatMap((key) =>
      (key.plural ? [`${key.key}_one`, `${key.key}_other`] : [key.key])
        .filter((entry) => !greek[entry])
        .map((entry) => `${key.file}:${key.line} ${entry}`),
    );
    expect(missing).toEqual([]);
  });

  test("holds nothing the app no longer asks for", () => {
    const asked = new Set(
      keys.flatMap((key) =>
        key.plural ? [`${key.key}_one`, `${key.key}_other`] : [key.key],
      ),
    );
    expect(Object.keys(greek).filter((entry) => !asked.has(entry))).toEqual([]);
  });

  test("keeps every placeholder of its English", () => {
    const names = (text: string) =>
      [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)]
        .map((match) => match[1])
        .sort()
        .join();
    expect(
      Object.entries(greek).filter(
        ([english, value]) =>
          names(english.replace(/_(one|other)$/, "")) !== names(value),
      ),
    ).toEqual([]);
  });

  test("leaves no English on a screen untranslated", () => {
    expect(
      sources.flatMap(({ file, source }) =>
        untranslatedIn(file, source).map(
          (hit) => `${file}:${hit.line} ${hit.text}`,
        ),
      ),
    ).toEqual([]);
  });
});
