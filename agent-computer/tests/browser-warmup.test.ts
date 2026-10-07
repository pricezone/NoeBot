import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warmUpArgs, warmUpBrowser } from "../src/browser-warmup";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-warmup-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a warm-up launch is headless, uses its own profile and can reach nothing", () => {
  const args = warmUpArgs("/tmp/w");
  expect(args).toContain("--headless=new");
  expect(args).toContain("--user-data-dir=/tmp/w/profile");
  expect(args).toContain("--proxy-server=socks5://127.0.0.1:9");
  expect(args).toContain("--disable-background-networking");
  expect(args.at(-1)).toStartWith("data:text/html,");
});

test("runs the browser once with those arguments and cleans up after it", async () => {
  const seen = join(root, "seen");
  const fake = join(root, "chrome");
  await writeFile(fake, `#!/bin/sh\necho "$@" > "${seen}"\nexit 0\n`);
  await chmod(fake, 0o755);

  const result = await warmUpBrowser(fake);

  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
  const args = await readFile(seen, "utf8");
  expect(args).toContain("--headless=new");
  const profile = args.match(/--user-data-dir=(\S+)\/profile/)?.[1] ?? "";
  expect(profile).not.toBe("");
  expect(await Bun.file(profile).exists()).toBe(false);
});

test("gives up on a browser that never finishes", async () => {
  const fake = join(root, "chrome");
  await writeFile(fake, "#!/bin/sh\nexec sleep 30\n");
  await chmod(fake, 0o755);

  const result = await warmUpBrowser(fake, { budgetMs: 200 });

  expect(result.timedOut).toBe(true);
  expect(result.ms).toBeLessThan(5_000);
});
