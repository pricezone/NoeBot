import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readThrough } from "../src/read-through";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-read-through-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("reads every file below the directory, nested ones too, and nothing twice", async () => {
  await mkdir(join(root, "locales"));
  await writeFile(join(root, "chrome"), Buffer.alloc(3 * 1024 * 1024 + 5));
  await writeFile(join(root, "locales", "en-US.pak"), "pak");
  // A link is not followed: the file it names is read where it lives, if it lives here at all.
  await symlink(join(root, "chrome"), join(root, "chrome-link"));

  expect(await readThrough(root)).toEqual({
    files: 2,
    bytes: 3 * 1024 * 1024 + 5 + 3,
  });
});
