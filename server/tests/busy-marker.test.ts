import { expect, test } from "bun:test";
import { busyFilePath, createBusyMarker } from "../src/busy-marker";

/*
 * While a run is going, and for a grace minute after, the app keeps a file fresh in its data folder;
 * HyperNoesis's agent on the VPS holds an automatic update while the file is young.
 */
function harness() {
  let clock = 1_000_000;
  const files = new Map<string, string>();
  const timers: Array<() => void> = [];
  const marker = createBusyMarker({
    path: "/data/.hypernoesis-busy",
    now: () => clock,
    write: (file, body) => files.set(file, body),
    remove: (file) => files.delete(file),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length as unknown as ReturnType<typeof setInterval>;
    },
    clearTimer: () => {
      timers.length = 0;
    },
  });
  return {
    marker,
    files,
    tick: (ms: number) => {
      clock += ms;
      for (const fn of [...timers]) fn();
    },
  };
}

test("a run writes the marker and keeps it fresh while it lasts", () => {
  const { marker, files, tick } = harness();
  const end = marker.runStarted();
  expect(JSON.parse(files.get("/data/.hypernoesis-busy") ?? "{}").runs).toBe(1);

  tick(20_000);
  expect(files.has("/data/.hypernoesis-busy")).toBe(true);
  end();
  expect(marker.open()).toBe(0);
});

test("the marker stays for a grace minute after the last run, then goes", () => {
  const { marker, files, tick } = harness();
  const end = marker.runStarted();
  end();
  // The gap between two runs of one browser turn: still busy.
  tick(20_000);
  expect(files.has("/data/.hypernoesis-busy")).toBe(true);
  tick(45_000);
  expect(files.has("/data/.hypernoesis-busy")).toBe(false);
});

test("overlapping runs keep it until the last ends, and ending twice counts once", () => {
  const { marker, files, tick } = harness();
  const first = marker.runStarted();
  const second = marker.runStarted();
  first();
  first();
  expect(marker.open()).toBe(1);
  tick(70_000);
  expect(files.has("/data/.hypernoesis-busy")).toBe(true);
  second();
  tick(61_000);
  expect(files.has("/data/.hypernoesis-busy")).toBe(false);
});

test("a marker that cannot be written never fails a run", () => {
  const marker = createBusyMarker({
    path: "/data/.hypernoesis-busy",
    write: () => {
      throw new Error("read-only file system");
    },
    setTimer: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearTimer: () => {},
  });
  expect(() => marker.runStarted()()).not.toThrow();
});

test("the file lives in the data folder, or nowhere outside a container", () => {
  expect(busyFilePath({ HYPERNOESIS_BUSY_FILE: "/tmp/x" })).toBe("/tmp/x");
  expect(busyFilePath({ OPENBOT_DATA_DIR: "/srv/app" }, 42)).toBe(
    "/srv/app/.hypernoesis/busy-42",
  );
});
