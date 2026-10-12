import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
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
