import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";

/**
 * The sentences the desktop launcher's native side says to a person, read out of its Rust source:
 * a failure's `said`, a step's detail, a harness's description. The launcher translates them where
 * it shows them (`localizeNative` in `desktop/src/i18n`), exactly or by pattern.
 *
 * What counts: a string literal outside the test modules that reads as a sentence (a capital first,
 * three words or more, a full stop, question mark or ellipsis last). Rust's own `{}`, `{name}` and
 * `{:?}` become `{{0}}`, `{{1}}`… in order, so a sentence built with `format!` matches by pattern.
 * A string with a line break in it is a native dialog's body, said by the Rust side itself, and
 * is left out.
 */

export type NativeSentence = { key: string; file: string; line: number };

const STRING = /"((?:[^"\\]|\\.)*)"/g;

function unescapeRust(literal: string): string {
  return literal
    .replace(/\\\n\s*/g, "")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

/** Rust's format placeholders as `{{0}}`, `{{1}}`…; `{{` and `}}` are Rust's literal braces. */
export function patternOf(text: string): string {
  let index = 0;
  return text
    .replaceAll("{{", "\u0000")
    .replaceAll("}}", "\u0001")
    .replace(/\{[^{}]*\}/g, () => `{{${index++}}}`)
    .replaceAll("\u0000", "{")
    .replaceAll("\u0001", "}");
}

export function isNativeSentence(text: string): boolean {
  return (
    /^[A-Z][a-z’']/.test(text) &&
    !text.includes("\\n") &&
    /[.?!…]$/.test(text) &&
    text.split(/\s+/).length >= 3
  );
}

export function nativeSentencesIn(
  file: string,
  text: string,
): NativeSentence[] {
  const cut = text.indexOf("#[cfg(test)]");
  const source = cut === -1 ? text : text.slice(0, cut);
  const found: NativeSentence[] = [];
  for (const match of source.matchAll(STRING)) {
    const raw = match[1] ?? "";
    if (!isNativeSentence(raw)) continue;
    found.push({
      key: patternOf(unescapeRust(raw)),
      file,
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

export function scanDesktopNative(root: string): NativeSentence[] {
  return [...new Glob("desktop/src-tauri/src/*.rs").scanSync(root)]
    .sort()
    .filter((file) => !/(_tests|test_support)\.rs$/.test(file))
    .flatMap((file) =>
      nativeSentencesIn(file, readFileSync(path.join(root, file), "utf8")),
    );
}
