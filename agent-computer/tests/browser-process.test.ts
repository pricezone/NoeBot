import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserProcessAlive } from "../src/profile-listing";

let profile: string;

beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), "openbot-lock-"));
});

afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

const lock = (target: string) =>
  symlink(target, join(profile, "SingletonLock"));

test("a lock naming this host and a running pid is a running browser", async () => {
  await lock(`machine-${process.pid}`);
  expect(await browserProcessAlive(profile, { host: "machine" })).toBe(true);
});

test("a lock left behind by a pid that has exited is a browser that is gone", async () => {
  await lock("machine-4242");
  expect(
    await browserProcessAlive(profile, {
      host: "machine",
      isRunning: () => false,
    }),
  ).toBe(false);
});

test("no lock at all is a browser that exited cleanly", async () => {
  expect(await browserProcessAlive(profile, { host: "machine" })).toBe(false);
});

test("a lock from another machine says nothing about a process here", async () => {
  await lock(`elsewhere-${process.pid}`);
  expect(await browserProcessAlive(profile, { host: "machine" })).toBe(false);
});

test("a host name with hyphens in it is read up to the last one", async () => {
  await lock(`83d1304be129e8-fly-${process.pid}`);
  expect(
    await browserProcessAlive(profile, { host: "83d1304be129e8-fly" }),
  ).toBe(true);
});
