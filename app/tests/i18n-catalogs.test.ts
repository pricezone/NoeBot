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
 * translation at all. Every check lists all of its violations at once, so one run says everything
 * there is to fix.
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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every entry for which `bad` says something, as "entry: what". */
function violations(
  bad: (item: (typeof entries)[number]) => string | undefined,
): string[] {
  return entries.flatMap((item) => {
    const said = bad(item);
    return said === undefined ? [] : [`${item.entry} → ${said}`];
  });
}

describe("Greek catalogs", () => {
  test("every value is a non-empty string in NFC", () => {
    expect(
      violations(({ value }) =>
        typeof value !== "string"
          ? "not a string"
          : value.trim() === ""
            ? "empty"
            : value !== value.normalize("NFC")
              ? "not NFC"
              : undefined,
      ),
    ).toEqual([]);
  });

  test("no entry translates something no code asks for any more", () => {
    expect(
      entries
        .filter(({ entry }) => !englishFor.has(entry))
        .map(({ namespace, entry }) => `${namespace}: ${entry}`),
    ).toEqual([]);
  });

  test("a translation keeps its English's placeholders and tags", () => {
    const placeholders = (text: string, entry: string) =>
      [...text.matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)]
        .map((match) => match[1] ?? "")
        // The singular may say "one" in words rather than repeat the count.
        .filter((name) => name !== "count" || !entry.endsWith("_one"))
        .sort()
        .join(",");
    const tags = (text: string) =>
      [...text.matchAll(/<\/?([\w-]+)\s*\/?>/g)]
        .map((match) => match[0])
        .sort()
        .join(",");
    expect(
      violations(({ entry, value }) => {
        const english = englishOf(entry);
        if (placeholders(value, entry) !== placeholders(english, entry))
          return `placeholders ${placeholders(value, entry)} vs ${placeholders(english, entry)}`;
        if (tags(value) !== tags(english))
          return `tags ${tags(value)} vs ${tags(english)}`;
        return undefined;
      }),
    ).toEqual([]);
  });

  test("a translation differs from its English, unless it is only names kept as they are", () => {
    expect(
      violations(({ entry, value }) => {
        if (value !== englishOf(entry)) return undefined;
        let rest = value.replace(/\{\{[^}]*\}\}/g, "").replace(/<[^>]*>/g, "");
        for (const term of [...glossary.keep].sort(
          (a, b) => b.length - a.length,
        ))
          rest = rest.replaceAll(term, "");
        return /\p{L}{2,}/u.test(rest) ? "identical to the English" : undefined;
      }),
    ).toEqual([]);
  });
});

describe("the glossary", () => {
  test("a glossary term is translated exactly as the glossary says", () => {
    expect(
      violations(({ entry, value }) => {
        const english = englishOf(entry).replace(/[.…]+$/, "");
        const term = glossary.exact[english];
        if (term === undefined) return undefined;
        const said = value.replace(/[.…]+$/, "");
        return said === term ? undefined : `${said}, not ${term}`;
      }),
    ).toEqual([]);
  });

  test("no machine translation the platform's catalogs were caught with", () => {
    expect(
      violations(({ value }) => {
        const bad = glossary.forbidden.find((word) =>
          new RegExp(
            `(^|[^\\p{L}])${escapeRegExp(plain(word))}([^\\p{L}]|$)`,
            "u",
          ).test(plain(value)),
        );
        return bad === undefined ? undefined : `uses "${bad}"`;
      }),
    ).toEqual([]);
  });

  test("names kept as they are stay as they are", () => {
    expect(
      violations(({ entry, value }) => {
        const lost = glossary.keep.filter(
          (term) =>
            new RegExp(`(^|[^\\p{L}])${escapeRegExp(term)}([^\\p{L}]|$)`, "u").test(
              englishOf(entry),
            ) && !value.includes(term),
        );
        return lost.length ? `lost ${lost.join(", ")}` : undefined;
      }),
    ).toEqual([]);
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
    expect(
      violations(({ value }) => {
        const wrong = greekWords(value).filter(
          (word) => /σ$/.test(word) || /ς./.test(word),
        );
        return wrong.length ? wrong.join(", ") : undefined;
      }),
    ).toEqual([]);
  });

  test("no Latin letter hiding inside a Greek word", () => {
    expect(
      violations(({ value }) => {
        const mixed = greekWords(value).filter((word) =>
          /\p{Script=Latin}/u.test(word),
        );
        return mixed.length ? mixed.join(", ") : undefined;
      }),
    ).toEqual([]);
  });

  test("a Greek question ends in ; and no polytonic accents", () => {
    expect(
      violations(({ value }) =>
        value.replace(/https?:\/\/\S+/g, "").includes("?")
          ? "uses ?"
          : /[ἀ-῿]/u.test(value)
            ? "polytonic"
            : undefined,
      ),
    ).toEqual([]);
  });

  test("the informal register, as on the platform's Noë Bot pages", () => {
    expect(
      violations(({ entry, value }) =>
        !glossary.formal.includes(entry) &&
        /(^|[^\p{L}])σας([^\p{L}]|$)/u.test(value)
          ? "formal σας"
          : undefined,
      ),
    ).toEqual([]);
  });
});

describe("translated files", () => {
  const translated = translatedFiles();

  test("stay free of untranslated English", () => {
    expect(
      translated.flatMap((file) =>
        (untranslated.get(file) ?? []).map(
          (hit) => `${file}:${hit.line} ${hit.where}: ${hit.text}`,
        ),
      ),
    ).toEqual([]);
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
    expect(
      translated.filter((file) => Bun.file(`${ROOT}/${file}`).size === 0),
    ).toEqual([]);
  });
});
