import { describe, expect, test } from "bun:test";
import {
  createDisplayNumbers,
  startFreshDisplay,
  startVirtualDisplay,
  type DisplayProcess,
  type DisplayRuntime,
} from "../src/virtual-display";

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function displayRuntime() {
  const ready = deferred<string>();
  const exited = deferred<number>();
  const readyWait = deferred<void>();
  const stopWait = deferred<void>();
  const killed = deferred<NodeJS.Signals>();
  const forceKilled = deferred<void>();
  const signals: NodeJS.Signals[] = [];
  let waits = 0;
  const process: DisplayProcess = {
    ready: ready.promise,
    exited: exited.promise,
    kill: (signal = "SIGTERM") => {
      signals.push(signal);
      killed.resolve(signal);
      if (signal === "SIGKILL") forceKilled.resolve();
      return true;
    },
  };
  const runtime: DisplayRuntime = {
    spawn: () => process,
    wait: () => (waits++ === 0 ? readyWait.promise : stopWait.promise),
  };
  return {
    runtime,
    ready,
    exited,
    readyWait,
    stopWait,
    killed,
    forceKilled,
    signals,
  };
}

describe("the virtual display behind a full browser", () => {
  test("does not start for the existing headless mode", async () => {
    const fake = displayRuntime();
    expect(await startVirtualDisplay("headless", fake.runtime)).toBeNull();
    expect(fake.signals).toEqual([]);
  });

  test("uses the display allocated by the Xvfb process it owns", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.ready.resolve(":143");
    const display = await starting;

    expect(display?.name).toBe(":143");
    expect(fake.signals).toEqual([]);

    const stopping = display?.stop();
    fake.exited.resolve(0);
    await stopping;
    expect(fake.signals).toEqual(["SIGTERM"]);
    expect(await display?.terminated).toEqual({ code: 0, expected: true });
  });

  test("reports an unexpected exit after the display became ready", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.ready.resolve(":7");
    const display = await starting;

    fake.exited.resolve(23);

    expect(await display?.terminated).toEqual({ code: 23, expected: false });
  });

  test("refuses to launch Chromium when its own display exits before readiness", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.exited.resolve(17);

    await expect(starting).rejects.toThrow(
      "The virtual display exited before it became ready (exit 17)",
    );
    expect(fake.signals).toEqual([]);
  });

  test("stops its display after the readiness deadline", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.readyWait.resolve();
    expect(await fake.killed.promise).toBe("SIGTERM");
    fake.exited.resolve(0);

    await expect(starting).rejects.toThrow(
      "The virtual display did not become ready",
    );
    expect(fake.signals).toEqual(["SIGTERM"]);
  });

  test("force-kills a display that ignores the graceful stop deadline", async () => {
    const fake = displayRuntime();
    const starting = startVirtualDisplay("headed", fake.runtime);
    fake.ready.resolve(":8");
    const display = await starting;

    const stopping = display?.stop();
    expect(await fake.killed.promise).toBe("SIGTERM");
    fake.stopWait.resolve();
    await fake.forceKilled.promise;
    fake.exited.resolve(137);
    await stopping;

    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(await display?.terminated).toEqual({ code: 137, expected: true });
  });
});

/** An Xvfb per spawn, each told what to do by the number it was asked for. */
function numberedRuntime(outcome: (args: string[]) => "ready" | "taken") {
  const spawned: string[][] = [];
  const runtime: DisplayRuntime = {
    spawn: (_command, args) => {
      spawned.push(args);
      const asked = args.find((arg) => /^:\d+$/.test(arg));
      const taken = outcome(args) === "taken";
      return {
        ready: taken
          ? new Promise<string>(() => undefined)
          : Promise.resolve(asked ?? ":0"),
        exited: taken
          ? Promise.resolve(1)
          : new Promise<number>(() => undefined),
        kill: () => true,
      };
    },
    wait: () => new Promise<void>(() => undefined),
  };
  return { runtime, spawned };
}

describe("display numbers for each Bot's desktop", () => {
  test("only go up, and skip any another X server holds", () => {
    const held = new Set([102]);
    const next = createDisplayNumbers({
      first: 100,
      last: 104,
      taken: (n) => held.has(n),
    });
    expect([next(), next(), next(), next()]).toEqual([100, 101, 103, 104]);
    // Round again only after the whole range, still skipping what is held.
    expect(next()).toBe(100);
  });

  test("are asked of Xvfb by number, with readiness still reported on the descriptor", async () => {
    const fake = numberedRuntime(() => "ready");
    const display = await startVirtualDisplay(
      "headed",
      fake.runtime,
      { width: 1440, height: 900 },
      117,
    );
    expect(display?.name).toBe(":117");
    expect(fake.spawned[0]?.slice(0, 3)).toEqual([":117", "-displayfd", "3"]);
  });

  test("move on to the next number when one is taken from under them", async () => {
    const fake = numberedRuntime((args) =>
      args.includes(":100") ? "taken" : "ready",
    );
    const next = createDisplayNumbers({ first: 100, taken: () => false });
    const display = await startFreshDisplay(
      { width: 1440, height: 900 },
      next,
      { runtime: fake.runtime },
    );
    expect(display.name).toBe(":101");
    expect(fake.spawned.map((args) => args[0])).toEqual([":100", ":101"]);
    // And the one after is new again, not the one that just went.
    expect(next()).toBe(102);
  });
});
