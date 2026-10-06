import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyDarkTheme,
  applyTheme,
  parseStoredDarkTheme,
  parseStoredTheme,
  resolveDark,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

describe("theme preference", () => {
  test("only the stored dark value enables dark theme", () => {
    expect(parseStoredDarkTheme("dark")).toBe(true);
    expect(parseStoredDarkTheme("light")).toBe(false);
    expect(parseStoredDarkTheme(null)).toBe(false);
  });

  test("the two values the key always held still mean what they meant", () => {
    expect(parseStoredTheme("dark")).toBe("dark");
    expect(parseStoredTheme("light")).toBe("light");
  });

  test("nothing stored, or a value this build does not know, follows the system", () => {
    expect(parseStoredTheme(null)).toBe("system");
    expect(parseStoredTheme("")).toBe("system");
    expect(parseStoredTheme("sepia")).toBe("system");
  });

  test("system resolves to the operating system's answer; the others ignore it", () => {
    expect(resolveDark("system", true)).toBe(true);
    expect(resolveDark("system", false)).toBe(false);
    expect(resolveDark("dark", false)).toBe(true);
    expect(resolveDark("light", true)).toBe(false);
  });

  test("persists and applies the selected theme", () => {
    const writes: Array<[string, string]> = [];
    const toggles: Array<[string, boolean]> = [];
    const schemes: Array<string> = [];

    applyDarkTheme(true, {
      setStoredValue: (key, value) => writes.push([key, value]),
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });

    expect(writes).toEqual([[THEME_STORAGE_KEY, "dark"]]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
  });

  test("system stores the preference, not what it resolved to", () => {
    const writes: Array<[string, string]> = [];
    const toggles: Array<[string, boolean]> = [];
    const schemes: Array<string> = [];

    applyTheme("system", true, {
      setStoredValue: (key, value) => writes.push([key, value]),
      toggleRootClass: (name, force) => toggles.push([name, force]),
      setRootColorScheme: (scheme) => schemes.push(scheme),
    });

    // A reload on a light desktop must come up light, so "dark" is never what gets written.
    expect(writes).toEqual([[THEME_STORAGE_KEY, "system"]]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
  });
});

describe("pre-paint theme boot", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  test("the boot script reads the same storage key the app writes", () => {
    expect(html).toContain(THEME_STORAGE_KEY);
  });

  test("the boot script runs before the first paint", () => {
    const boot = html.match(/<script(?![^>]*\bsrc=)[^>]*>/);

    expect(boot).not.toBeNull();
    expect(boot?.[0]).not.toContain("module");
    expect(boot?.[0]).not.toContain("defer");
  });

  test("the boot script applies the dark class itself", () => {
    expect(html).toContain("documentElement");
    expect(html).toMatch(/classList[\s\S]*dark/);
  });

  test("the document declares a color scheme before the stylesheet arrives", () => {
    expect(html).toContain("colorScheme");
  });

  /*
   * The boot script cannot import the library, so it carries its own copy of the rule. This runs
   * that copy against the same cases the library answers, so the two cannot drift: a stored value
   * the library reads as "system" must make the page follow the operating system before paint too.
   */
  test("the boot script resolves the stored value the way the library does", () => {
    const boot = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
    const source = boot?.[1];
    expect(source).toBeDefined();
    if (!source) return;

    const cases: Array<[string | null, boolean]> = [
      ["dark", false],
      ["light", true],
      [null, true],
      [null, false],
      ["sepia", true],
    ];
    for (const [stored, systemDark] of cases) {
      const classes = new Map<string, boolean>();
      const documentElement = {
        classList: {
          toggle: (name: string, force: boolean) => classes.set(name, force),
        },
        style: {} as { colorScheme?: string },
      };
      const run = new Function(
        "window",
        "document",
        // The script is a classic one, so its top-level `const` is fine inside a function body.
        source,
      );
      run(
        {
          localStorage: { getItem: () => stored },
          matchMedia: () => ({ matches: systemDark }),
        },
        { documentElement },
      );
      const expected = resolveDark(parseStoredTheme(stored), systemDark);
      expect(classes.get("dark")).toBe(expected);
      expect(documentElement.style.colorScheme).toBe(
        expected ? "dark" : "light",
      );
    }
  });
});

describe("color scheme", () => {
  const styles = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );

  test("both themes tell the browser which one they are", () => {
    expect(styles).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light/);
    expect(styles).toMatch(/\.dark\s*\{[\s\S]*?color-scheme:\s*dark/);
  });
});
