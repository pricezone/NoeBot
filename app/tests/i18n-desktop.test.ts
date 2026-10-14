import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import { scanDesktopNative } from "../../scripts/i18n/desktop-scan";
import { keysIn, parse, untranslatedIn } from "../../scripts/i18n/scan";
import { ROOT } from "../../scripts/i18n/source";

/**
 * The desktop launcher's Greek, held to what its source asks for: the window's own words
 * (`el.json`) and what the native side says (`native.el.json`, read out of the Rust source). The
 * launcher is its own package, so it keeps a copy of the language list, held to the original.
 */

const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

test("desktop/src/i18n/locales.ts is shared/i18n/locales.ts, byte for byte", () => {
  expect(read("desktop/src/i18n/locales.ts")).toBe(
    read("shared/i18n/locales.ts"),
  );
});

const files = [...new Glob("desktop/src/*.{ts,tsx}").scanSync(ROOT)]
  .filter((file) => !file.includes(".test."))
  .sort();
const sources = files.map((file) => ({
  file,
  source: parse(file, read(file)),
}));
const asked = new Set(
  sources.flatMap(({ file, source }) =>
    keysIn(file, source).flatMap((key) =>
      key.plural ? [`${key.key}_one`, `${key.key}_other`] : [key.key],
    ),
  ),
);
const native = new Set(scanDesktopNative(ROOT).map((sentence) => sentence.key));
const greek = JSON.parse(read("desktop/src/i18n/el.json")) as Record<
  string,
  string
>;
const nativeGreek = JSON.parse(
  read("desktop/src/i18n/native.el.json"),
) as Record<string, string>;

const names = (text: string) =>
  [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
    .map((match) => match[1])
    .sort()
    .join();

describe("desktop Greek", () => {
  test("the window's words: every key has Greek, and nothing is stale", () => {
    expect([...asked].filter((entry) => !greek[entry])).toEqual([]);
    expect(Object.keys(greek).filter((entry) => !asked.has(entry))).toEqual([]);
  });

  test("the native side's sentences: every one has Greek, and nothing is stale", () => {
    expect([...native].filter((entry) => !nativeGreek[entry])).toEqual([]);
    expect(
      Object.keys(nativeGreek).filter((entry) => !native.has(entry)),
    ).toEqual([]);
  });

  test("every Greek entry keeps its English's placeholders", () => {
    expect(
      [...Object.entries(greek), ...Object.entries(nativeGreek)].filter(
        ([english, value]) =>
          names(english.replace(/_(one|other)$/, "")) !== names(value),
      ),
    ).toEqual([]);
  });

  test("no English on a screen goes untranslated", () => {
    expect(
      sources.flatMap(({ file, source }) =>
        untranslatedIn(file, source).map(
          (hit) => `${file}:${hit.line} ${hit.text}`,
        ),
      ),
    ).toEqual([]);
  });
});
