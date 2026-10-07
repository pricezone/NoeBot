import { expect, test } from "bun:test";
import {
  DISABLED_FEATURES,
  desktopWindowArgs,
  LAUNCH_ARGS,
  PLAYWRIGHT_DISABLED_FEATURES,
} from "../src/profiles";

test("on a desktop the browser opens maximized, and is told nothing about windows without one", () => {
  expect(desktopWindowArgs(true)).toEqual(["--start-maximized"]);
  expect(desktopWindowArgs(false)).toEqual([]);
});

test("one --disable-features switch carries Playwright's list and the Client-Hints restarts", () => {
  const switches = LAUNCH_ARGS.filter((arg) =>
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

test("the list repeats what the installed Playwright switches off", async () => {
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
