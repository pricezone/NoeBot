import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_HOMEPAGE, homepageFromEnv } from "../src/browser-request";
import {
  acceptLanguages,
  browserLanguageFor,
  browserLanguageVariableFor,
  DEFAULT_BROWSER_LANGUAGE,
  DISABLED_FEATURES,
  desktopWindowArgs,
  launchArgs,
  PLAYWRIGHT_DISABLED_FEATURES,
} from "../src/launch-args";

const managed = launchArgs({ sandbox: false, localChrome: false });

test("on a desktop the browser opens maximized, and is told nothing about windows without one", () => {
  expect(desktopWindowArgs(true)).toEqual([
    "--start-maximized",
    "--hide-crash-restore-bubble",
  ]);
  expect(desktopWindowArgs(false)).toEqual([]);
  expect(desktopWindowArgs(true, { gpu: false })).toEqual([
    "--start-maximized",
    "--hide-crash-restore-bubble",
    "--disable-gpu",
  ]);
});

test("one --disable-features switch carries Playwright's list and the Client-Hints restarts", () => {
  const switches = managed.filter((arg) =>
    arg.startsWith("--disable-features="),
  );
  expect(switches).toHaveLength(1);
  const features = switches[0]?.slice("--disable-features=".length).split(",");
  expect(features).toEqual([...DISABLED_FEATURES]);
  for (const name of PLAYWRIGHT_DISABLED_FEATURES) {
    expect(features).toContain(name);
  }
  expect(features).toContain("AcceptCHFrame");
  expect(features).toContain("CriticalClientHint");
});

test("the browser speaks English, wherever the traffic leaves from", () => {
  // The browser's own language, and the one it asks every site for, whatever the machine's locale.
  expect(managed).toContain("--lang=en-US");
  expect(managed).toContain("--accept-lang=en-US,en");
});

test("a deployment can give the browser another language, for every Bot or for one", () => {
  // Unset, English, as before.
  expect(browserLanguageFor("sales-bot", {})).toBe(DEFAULT_BROWSER_LANGUAGE);
  expect(DEFAULT_BROWSER_LANGUAGE).toBe("en-US");
  // Every Bot, from COMPUTER_BROWSER_LANG, in its canonical spelling.
  expect(
    browserLanguageFor("sales-bot", { COMPUTER_BROWSER_LANG: "el-gr" }),
  ).toBe("el-GR");
  // One Bot, by the rule EGRESS_PROXY_<BOT> uses, ahead of the deployment's.
  expect(browserLanguageVariableFor("sales-bot")).toBe(
    "COMPUTER_BROWSER_LANG_SALES_BOT",
  );
  const env = {
    COMPUTER_BROWSER_LANG: "el-GR",
    COMPUTER_BROWSER_LANG_SALES_BOT: "de-DE",
  };
  expect(browserLanguageFor("sales-bot", env)).toBe("de-DE");
  expect(browserLanguageFor("support", env)).toBe("el-GR");
  expect(browserLanguageFor(undefined, env)).toBe("el-GR");
});

test("a value that is not a language tag never reaches the command line", () => {
  for (const value of [
    "",
    "  ",
    "--no-sandbox",
    "el GR",
    "el-GR;rm -rf",
    "x",
  ]) {
    expect(browserLanguageFor("bot", { COMPUTER_BROWSER_LANG: value })).toBe(
      "en-US",
    );
  }
  // A broken per-Bot value falls back to the deployment's, not to English.
  expect(
    browserLanguageFor("bot", {
      COMPUTER_BROWSER_LANG_BOT: "--lang=xx",
      COMPUTER_BROWSER_LANG: "fr-FR",
    }),
  ).toBe("fr-FR");
});

test("the language is what the browser speaks and asks every site for, English after it", () => {
  const greek = launchArgs({
    sandbox: false,
    localChrome: false,
    language: "el-GR",
  });
  expect(greek).toContain("--lang=el-GR");
  expect(greek).toContain("--accept-lang=el-GR,el,en-US,en");
  expect(greek).not.toContain("--lang=en-US");
  expect(acceptLanguages("en-US")).toBe("en-US,en");
  expect(acceptLanguages("en-GB")).toBe("en-GB,en");
  expect(acceptLanguages("de")).toBe("de,en-US,en");
  // A person's own Chrome keeps its own, whatever the deployment says.
  expect(
    launchArgs({ sandbox: true, localChrome: true, language: "el-GR" }).some(
      (arg) => arg.startsWith("--lang") || arg.startsWith("--accept-lang"),
    ),
  ).toBe(false);
});

test("the start page follows the browser's language unless the deployment names one", () => {
  expect(homepageFromEnv(undefined, "el-GR")).toBe(
    "https://www.google.com/?hl=el",
  );
  expect(homepageFromEnv(undefined, "en-US")).toBe(DEFAULT_HOMEPAGE);
  expect(homepageFromEnv(undefined)).toBe(DEFAULT_HOMEPAGE);
  expect(homepageFromEnv("https://duckduckgo.com", "el-GR")).toBe(
    "https://duckduckgo.com/",
  );
});

test("a person's own Chrome keeps its language, its keychain and its sandbox", () => {
  const local = launchArgs({ sandbox: true, localChrome: true });
  expect(local).not.toContain("--lang=en-US");
  expect(local).not.toContain("--password-store=basic");
  expect(local).not.toContain("--no-sandbox");
  expect(managed).toContain("--no-sandbox");
});

// The root CI install deliberately excludes this separately deployed package's dependencies.
test.skipIf(
  !existsSync(
    join(import.meta.dir, "../node_modules/playwright-core/package.json"),
  ),
)("the list repeats what the installed Playwright switches off", async () => {
  const bundle = Bun.resolveSync(
    "playwright-core/package.json",
    import.meta.dir,
  );
  const source = await Bun.file(
    bundle.replace(/package\.json$/, "lib/coreBundle.js"),
  ).text();
  const start = source.indexOf("disabledFeatures = [");
  const end = source.indexOf("];", start);
  expect(start).toBeGreaterThan(-1);
  const shipped = [...source.slice(start, end).matchAll(/"([A-Za-z0-9_]+)"/g)]
    .map((match) => match[1])
    .slice(0, PLAYWRIGHT_DISABLED_FEATURES.length);
  expect(shipped).toEqual([...PLAYWRIGHT_DISABLED_FEATURES]);
});
