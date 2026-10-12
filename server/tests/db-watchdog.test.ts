import { describe, expect, test } from "bun:test";
import { startPoolWatchdog } from "../src/db/watchdog";

/**
 * The pool watchdog: the one thing that turns a database pool that has stopped answering into a
 * restart rather than an outage. See the module's header for the incident it comes from.
 */

const hangs = () => new Promise<never>(() => {});
const answers = async () => 1;
const refuses = async () => {
  throw new Error("connection refused");
};

const FAST = { intervalMs: 60_000, timeoutMs: 20 } as const;

describe("the pool watchdog", () => {
  test("a pool that answers is ok, and nothing is logged", async () => {
    const log: Record<string, unknown>[] = [];
    const dog = startPoolWatchdog({
      ...FAST,
      pooled: answers,
      fresh: answers,
      onWedged: () => {
        throw new Error("not wedged");
      },
      log: (line) => log.push(line),
    });
    try {
      expect(dog.state()).toBe("unknown");
      expect(await dog.check()).toBe("ok");
      expect(dog.state()).toBe("ok");
      expect(log).toEqual([]);
    } finally {
      dog.stop();
    }
  });

  test("a pool that never answers while a fresh connection does is wedged, on the second strike", async () => {
    const wedged: number[] = [];
    const log: Record<string, unknown>[] = [];
    const dog = startPoolWatchdog({
      ...FAST,
      pooled: hangs,
      fresh: answers,
      onWedged: ({ strikes }) => wedged.push(strikes),
      log: (line) => log.push(line),
    });
    try {
      expect(await dog.check()).toBe("wedged");
      // One slow check under load is not a reason to drop every request in flight.
      expect(wedged).toEqual([]);
      expect(await dog.check()).toBe("wedged");
      expect(wedged).toEqual([2]);
      expect(log.map((line) => line.type)).toEqual([
        "database-pool-wedged",
        "database-pool-wedged",
      ]);
    } finally {
      dog.stop();
    }
  });

  test("an answer in between resets the strikes", async () => {
    const wedged: number[] = [];
    let pooledHangs = true;
    const dog = startPoolWatchdog({
      ...FAST,
      pooled: () => (pooledHangs ? hangs() : answers()),
      fresh: answers,
      onWedged: ({ strikes }) => wedged.push(strikes),
    });
    try {
      expect(await dog.check()).toBe("wedged");
      pooledHangs = false;
      expect(await dog.check()).toBe("ok");
      pooledHangs = true;
      expect(await dog.check()).toBe("wedged");
      expect(wedged).toEqual([]);
    } finally {
      dog.stop();
    }
  });

  test("a database nobody reaches is unreachable, never wedged, and logged once", async () => {
    const log: Record<string, unknown>[] = [];
    const dog = startPoolWatchdog({
      ...FAST,
      pooled: hangs,
      fresh: hangs,
      onWedged: () => {
        throw new Error("a restart would not bring the database back");
      },
      log: (line) => log.push(line),
    });
    try {
      expect(await dog.check()).toBe("unreachable");
      expect(await dog.check()).toBe("unreachable");
      expect(await dog.check()).toBe("unreachable");
      expect(log.map((line) => line.type)).toEqual(["database-unreachable"]);
    } finally {
      dog.stop();
    }
  });

  test("a pooled query that is refused outright is an unreachable database, not a wedge", async () => {
    const dog = startPoolWatchdog({
      ...FAST,
      pooled: refuses,
      fresh: refuses,
      onWedged: () => {
        throw new Error("the pool answered, with a refusal");
      },
    });
    try {
      expect(await dog.check()).toBe("unreachable");
    } finally {
      dog.stop();
    }
  });

  test("the database coming back is said once, and the state is ok again", async () => {
    const log: Record<string, unknown>[] = [];
    let down = true;
    const dog = startPoolWatchdog({
      ...FAST,
      pooled: () => (down ? hangs() : answers()),
      fresh: () => (down ? hangs() : answers()),
      onWedged: () => {
        throw new Error("not wedged");
      },
      log: (line) => log.push(line),
    });
    try {
      expect(await dog.check()).toBe("unreachable");
      down = false;
      expect(await dog.check()).toBe("ok");
      expect(log.map((line) => line.type)).toEqual([
        "database-unreachable",
        "database-reachable-again",
      ]);
    } finally {
      dog.stop();
    }
  });

  test("it checks on its own, and stop() ends that", async () => {
    let checks = 0;
    const dog = startPoolWatchdog({
      intervalMs: 5,
      timeoutMs: 20,
      pooled: async () => {
        checks += 1;
        return 1;
      },
      fresh: answers,
      onWedged: () => {
        throw new Error("not wedged");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(checks).toBeGreaterThanOrEqual(2);
    dog.stop();
    const seen = checks;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(checks).toBe(seen);
  });
});
