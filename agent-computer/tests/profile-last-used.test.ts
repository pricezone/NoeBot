import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botIdsIn, lastUsedProfile } from "../src/profile-listing";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-last-used-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function profile(botId: string, usedAt: Date | null): Promise<void> {
  const dir = join(root, botId);
  await mkdir(dir, { recursive: true });
  if (!usedAt) return;
  const state = join(dir, "Local State");
  await writeFile(state, "{}");
  await utimes(state, usedAt, usedAt);
}

test("the browser used last is the profile Chromium wrote to last", async () => {
  await profile("assistant", new Date("2026-10-07T10:00:00Z"));
  await profile("researcher", new Date("2026-10-06T10:00:00Z"));
  // Made but never opened: no browser state, so never the one to bring back.
  await profile("fresh", null);
  await mkdir(join(root, "lost+found"));

  const ids = botIdsIn(await readdir(root, { withFileTypes: true }));
  expect(ids).not.toContain("lost+found");
  expect(await lastUsedProfile(root, ids)).toBe("assistant");
});

test("no profile with a browser in it means no last-used Bot", async () => {
  await profile("fresh", null);
  expect(await lastUsedProfile(root, ["fresh"])).toBeNull();
});
