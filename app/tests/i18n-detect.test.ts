import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type LocaleInputs, resolveLocale } from "@/lib/i18n/detect";
import {
  type Locale,
  normalizeLocale,
  parseLocales,
  pickLocale,
} from "../../shared/i18n/locales";

/**
 * Which language the interface speaks, and who decided it.
 */

describe("the shared language list", () => {
  test("a tag means the language it starts with, and nothing else counts", () => {
    expect(normalizeLocale("el-GR")).toBe("el");
    expect(normalizeLocale(" EL ")).toBe("el");
    expect(normalizeLocale("el_CY")).toBe("el");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
    expect(normalizeLocale(3)).toBeNull();
  });

  test("a deployment always offers English, and only what it names besides", () => {
    expect(parseLocales(undefined)).toEqual(["en"]);
    expect(parseLocales("")).toEqual(["en"]);
    expect(parseLocales("el")).toEqual(["en", "el"]);
    expect(parseLocales("el-GR, fr ,en")).toEqual(["en", "el"]);
  });

  test("the first candidate the deployment offers wins", () => {
    expect(pickLocale(["fr-FR", "el-GR", "en"], ["en", "el"])).toBe("el");
    expect(pickLocale(["el-GR", "en"], ["en"])).toBe("en");
    expect(pickLocale(["fr"], ["en", "el"])).toBeNull();
  });
});

describe("choosing the interface language", () => {
  const both: Locale[] = ["en", "el"];
  const resolve = (input: Partial<LocaleInputs>) =>
    resolveLocale({ enabled: both, ...input });

  test("a signed-in person's saved choice follows them, over this browser's memory", () => {
    expect(resolve({ server: "el", stored: "en" })).toBe("el");
    expect(resolve({ server: "en", stored: "el", browser: ["el"] })).toBe("en");
  });

  test("a choice this browser could not save is the newest word, and wins", () => {
    expect(resolve({ server: "en", stored: "el", unsynced: true })).toBe("el");
  });

  test("without a saved choice: this browser's choice, then the deployment's default, then the browser's languages", () => {
    expect(resolve({ server: null, stored: "el" })).toBe("el");
    expect(resolve({ deploymentDefault: "el", browser: ["en-GB"] })).toBe("el");
    expect(resolve({ browser: ["fr-FR", "el-GR"] })).toBe("el");
    expect(resolve({ browser: ["de"] })).toBe("en");
    expect(resolve({})).toBe("en");
  });

  test("a language the deployment no longer offers is passed over at every step", () => {
    const english = (input: Partial<LocaleInputs>) =>
      resolveLocale({ enabled: ["en"], ...input });
    expect(english({ server: "el" })).toBe("en");
    expect(english({ stored: "el", unsynced: true })).toBe("en");
    expect(english({ deploymentDefault: "el", browser: ["el"] })).toBe("en");
  });
});

describe("the pre-paint language script", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const inline = [
    ...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
  ].map((match) => match[1] ?? "");

  test("comes second, so the theme script stays first", () => {
    expect(inline.length).toBeGreaterThanOrEqual(2);
    expect(inline[0]).toContain("openbot-theme");
    expect(inline[1]).toContain("openbot-locale");
  });

  /*
   * The script cannot import the library, so it carries its own copy of the rule. This runs that
   * copy against the cases `resolveLocale` answers for a first paint (no server yet), so the two
   * cannot drift.
   */
  test("decides what the library decides", () => {
    const source = inline[1] ?? "";
    type Case = {
      stored?: string;
      offered?: string;
      deploymentDefault?: string;
      preview?: boolean;
      browser: string[];
    };
    const cases: Case[] = [
      { browser: ["en-US"] },
      { browser: ["el-GR"] },
      { browser: ["el-GR"], offered: "en,el" },
      { browser: ["el-GR"], preview: true },
      { browser: ["en-US"], offered: "en,el", deploymentDefault: "el" },
      { browser: ["el-GR"], offered: "en,el", stored: "en" },
      { browser: ["en-US"], offered: "en,el", stored: "el" },
      { browser: ["en-US"], stored: "el" },
      { browser: ["fr-FR", "el"], offered: "en,el" },
      { browser: ["de"], offered: "en,el" },
    ];
    for (const item of cases) {
      const storage = new Map<string, string>(
        Object.entries({
          "openbot-locale": item.stored,
          "openbot-locales": item.offered,
          "openbot-locale-default": item.deploymentDefault,
          "openbot-i18n-preview": item.preview ? "1" : undefined,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const documentElement = { lang: "unset" };
      new Function("window", "document", source)(
        {
          localStorage: { getItem: (key: string) => storage.get(key) ?? null },
          navigator: { languages: item.browser, language: item.browser[0] },
        },
        { documentElement },
      );
      const offered = parseLocales(item.offered);
      const enabled: Locale[] = item.preview ? ["en", "el"] : offered;
      const deploymentDefault = normalizeLocale(item.deploymentDefault);
      const expected = resolveLocale({
        stored: normalizeLocale(item.stored),
        deploymentDefault:
          deploymentDefault && offered.includes(deploymentDefault)
            ? deploymentDefault
            : null,
        browser: item.browser,
        enabled,
      });
      expect({ case: item, lang: documentElement.lang }).toEqual({
        case: item,
        lang: expected,
      });
    }
  });
});
