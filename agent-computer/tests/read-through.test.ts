import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

// Root reads anything, so there is no unreadable file to make when the suite runs as root.
test.skipIf(process.getuid?.() === 0)(
  "passes over a file it may not read and reads the rest",
  async () => {
    await writeFile(join(root, "rpm.deps"), "secret");
    await chmod(join(root, "rpm.deps"), 0o000);
    await writeFile(join(root, "chrome"), "binary");

    expect(await readThrough(root)).toEqual({ files: 1, bytes: 6 });
  },
);
