import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellLog } from "../src/shell-log";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "openbot-shell-log-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the shell mirror the desktop terminal tails", () => {
  test("writes the prompt, the output and the exit line in order", async () => {
    const log = createShellLog(join(dir, "shell.log"));
    log.begin("ls -la");
    log.write("total 0\n");
    log.write("drwxr-xr-x  notes\n");
    log.end({ exitCode: 0, timedOut: false, elapsedMs: 1234 });
    await log.settled();

    expect(await readFile(join(dir, "shell.log"), "utf8")).toBe(
      "\n$ ls -la\ntotal 0\ndrwxr-xr-x  notes\n[exit 0 · 1.2s]\n",
    );
  });

  test("says when a command was cut off rather than inventing an exit code", async () => {
    const log = createShellLog(join(dir, "shell.log"));
    log.begin("sleep 600");
    log.end({ exitCode: -1, timedOut: true, elapsedMs: 120_000 });
    await log.settled();

    expect(await readFile(join(dir, "shell.log"), "utf8")).toContain(
      "[timed out after 120.0s]",
    );
  });

  test("rotates a file that has grown past its cap instead of growing it further", async () => {
    const path = join(dir, "shell.log");
    await writeFile(path, "x".repeat(64));
    const log = createShellLog(path, { maxBytes: 64 });
    log.begin("echo after");
    await log.settled();

    expect((await stat(`${path}.1`)).size).toBe(64);
    expect(await readFile(path, "utf8")).toBe("\n$ echo after\n");
  });

  test("a path that cannot be written never fails the command", async () => {
    const log = createShellLog(join(dir, "missing", "deeper", "shell.log"));
    log.begin("true");
    log.end({ exitCode: 0, timedOut: false, elapsedMs: 1 });
    await expect(log.settled()).resolves.toBeUndefined();
  });
});
