import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  catalogEntriesFor,
  greekCatalogs,
  ROOT,
  scanApp,
  translatedFiles,
} from "../../scripts/i18n/source";

/**
 * The Greek catalogs: complete where a file says it is translated, free of entries nothing asks for,
 * shaped like the English they translate, and written the way the glossary says.
 *
 * Keys are read from the source (`scripts/i18n/scan.ts`); `bun scripts/i18n/extract.ts --missing`
 * lists what is left to translate, and `bun scripts/i18n/guard.ts` what is not yet going through a
 * translation at all.
 */

const { keys, untranslated } = scanApp();
const catalogs = greekCatalogs();
const glossary = JSON.parse(
  readFileSync(`${ROOT}/docs/i18n/glossary.json`, "utf8"),
) as {
  keep: string[];
  exact: Record<string, string>;
  forbidden: string[];
  formal: string[];
};

/** The English each catalog entry some code asks for translates (its key, before plural or context). */
const englishFor = new Map<string, string>();
for (const key of keys)
  for (const entry of catalogEntriesFor(key)) englishFor.set(entry, key.key);

function englishOf(entry: string): string {
  return englishFor.get(entry) ?? entry.replace(/_(one|other)$/, "");
}

const entries = [...catalogs].flatMap(([namespace, catalog]) =>
  Object.entries(catalog).map(([entry, value]) => ({
    namespace,
    entry,
    value,
  })),
);

const plain = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

describe("Greek catalogs", () => {
  test("every value is a non-empty string in NFC", () => {
    for (const { namespace, entry, value } of entries) {
      expect({ namespace, entry, ok: typeof value === "string" }).toEqual({
        namespace,
        entry,
        ok: true,
      });
      expect({ entry, empty: value.trim() === "" }).toEqual({
        entry,
        empty: false,
      });
      expect({ entry, nfc: value === value.normalize("NFC") }).toEqual({
        entry,
        nfc: true,
      });
    }
  });

  test("no entry translates something no code asks for any more", () => {
    const stale = entries
      .filter(({ entry }) => !englishFor.has(entry))
      .map(({ namespace, entry }) => `${namespace}: ${entry}`);
    expect(stale).toEqual([]);
  });

  test("a translation keeps its English's placeholders and tags", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)]
        .map((match) => match[1])
        .sort();
    const tags = (text: string) =>
      [...text.matchAll(/<\/?([\w-]+)\s*\/?>/g)]
        .map((match) => match[0])
        .sort();
    for (const { entry, value } of entries) {
      const english = englishOf(entry);
      // The singular may say "one" in words rather than repeat the count.
      const comparable = (text: string) =>
        placeholders(text).filter(
          (name) => name !== "count" || !entry.endsWith("_one"),
        );
      expect({ entry, placeholders: comparable(value) }).toEqual({
        entry,
        placeholders: comparable(english),
      });
      expect({ entry, tags: tags(value) }).toEqual({
        entry,
        tags: tags(english),
      });
    }
  });

  test("a translation differs from its English, unless it is only names kept as they are", () => {
    for (const { entry, value } of entries) {
      if (value !== englishOf(entry)) continue;
      let rest = value.replace(/\{\{[^}]*\}\}/g, "").replace(/<[^>]*>/g, "");
      for (const term of glossary.keep) rest = rest.replaceAll(term, "");
      expect({ entry, untranslated: /\p{L}{2,}/u.test(rest) }).toEqual({
        entry,
        untranslated: false,
      });
    }
  });
});

describe("the glossary", () => {
  test("a glossary term is translated exactly as the glossary says", () => {
    for (const { entry, value } of entries) {
      const english = englishOf(entry).replace(/[.…]+$/, "");
      const term = glossary.exact[english];
      if (term === undefined) continue;
      expect({ entry, value: value.replace(/[.…]+$/, "") }).toEqual({
        entry,
        value: term,
      });
    }
  });

  test("no machine translation the platform's catalogs were caught with", () => {
    for (const { entry, value } of entries)
      for (const bad of glossary.forbidden)
        expect({
          entry,
          bad: new RegExp(`(^|[^\\p{L}])${plain(bad)}([^\\p{L}]|$)`, "u").test(
            plain(value),
          ),
        }).toEqual({ entry, bad: false });
  });

  test("names kept as they are stay as they are", () => {
    for (const { entry, value } of entries)
      for (const term of glossary.keep) {
        const pattern = new RegExp(`(^|[^\\p{L}])${term}([^\\p{L}]|$)`, "u");
        if (!pattern.test(englishOf(entry))) continue;
        expect({ entry, term, kept: value.includes(term) }).toEqual({
          entry,
          term,
          kept: true,
        });
      }
  });
});

describe("Greek spelling", () => {
  const greekWords = (text: string) =>
    text
      .replace(/\{\{[^}]*\}\}/g, " ")
      .replace(/<[^>]*>/g, " ")
      .split(/[^\p{L}\p{M}]+/u)
      .filter((word) => /\p{Script=Greek}/u.test(word));

  test("final sigma at the end of a word, and only there", () => {
    for (const { entry, value } of entries)
      for (const word of greekWords(value)) {
        expect({
          entry,
          word,
          ok: !/σ$/.test(word) && !/ς./.test(word),
        }).toEqual({
          entry,
          word,
          ok: true,
        });
      }
  });

  test("no Latin letter hiding inside a Greek word", () => {
    for (const { entry, value } of entries)
      for (const word of greekWords(value))
        expect({ entry, word, mixed: /\p{Script=Latin}/u.test(word) }).toEqual({
          entry,
          word,
          mixed: false,
        });
  });

  test("a Greek question ends in ; and no polytonic accents", () => {
    for (const { entry, value } of entries) {
      const withoutLinks = value.replace(/https?:\/\/\S+/g, "");
      expect({ entry, question: withoutLinks.includes("?") }).toEqual({
        entry,
        question: false,
      });
      expect({ entry, polytonic: /[ἀ-῿]/u.test(value) }).toEqual({
        entry,
        polytonic: false,
      });
    }
  });

  test("the informal register, as on the platform's Noë Bot pages", () => {
    for (const { entry, value } of entries) {
      if (glossary.formal.includes(entry)) continue;
      expect({
        entry,
        formal: /(^|[^\p{L}])σας([^\p{L}]|$)/u.test(value),
      }).toEqual({
        entry,
        formal: false,
      });
    }
  });
});

describe("translated files", () => {
  const translated = translatedFiles();

  test("stay free of untranslated English", () => {
    const regressions = translated.flatMap((file) =>
      (untranslated.get(file) ?? []).map(
        (hit) => `${file}:${hit.line} ${hit.where}: ${hit.text}`,
      ),
    );
    expect(regressions).toEqual([]);
  });

  test("have Greek for every key they ask for", () => {
    const missing: string[] = [];
    for (const key of keys) {
      if (!translated.includes(key.file)) continue;
      const own = catalogs.get(key.namespace) ?? {};
      const common = catalogs.get("common") ?? {};
      for (const entry of catalogEntriesFor(key))
        if (!own[entry] && !common[entry])
          missing.push(`${key.file}:${key.line} ${key.namespace}: ${entry}`);
    }
    expect(missing).toEqual([]);
  });

  test("name files that exist", () => {
    for (const file of translated)
      expect({ file, exists: Bun.file(`${ROOT}/${file}`).size > 0 }).toEqual({
        file,
        exists: true,
      });
  });
});
