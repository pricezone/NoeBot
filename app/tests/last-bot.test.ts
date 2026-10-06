import { describe, expect, test } from "bun:test";
import {
  LAST_BOT_STORAGE_KEY,
  parseStoredLastBot,
  readLastBot,
  rememberLastBot,
} from "../src/lib/agents/last-bot";

/** A `Storage` that remembers, so the writer and the reader can be run against the same slot. */
function memoryStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
    items,
  };
}

/** A `Storage` whose every access throws, the way a private window's can. */
const brokenStorage = {
  getItem: (): string | null => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: (): void => {
    throw new DOMException("denied", "SecurityError");
  },
};

describe("last bot preference", () => {
  /*
   * The test that matters: the writer and the reader are two functions and nothing but this holds
   * their key together. Drift here does not throw, it silently stops the landing from remembering.
   */
  test("a round trip through storage preserves the Bot", () => {
    const storage = memoryStorage();

    rememberLastBot("assistant", storage);

    expect(storage.items.get(LAST_BOT_STORAGE_KEY)).toBe("assistant");
    expect(readLastBot(storage)).toBe("assistant");
  });

  test("the newest write wins", () => {
    const storage = memoryStorage();

    rememberLastBot("assistant", storage);
    rememberLastBot("researcher", storage);

    expect(readLastBot(storage)).toBe("researcher");
  });

  test("nothing stored reads as null", () => {
    expect(readLastBot(memoryStorage())).toBeNull();
  });

  /*
   * An empty or blank value is not a Bot id. Reading it as one would make the landing look for a
   * Bot called "" and, worse, hide the fact that nothing useful was ever remembered.
   */
  test("a blank stored value is ignored", () => {
    expect(parseStoredLastBot("")).toBeNull();
    expect(parseStoredLastBot("   ")).toBeNull();
    expect(parseStoredLastBot(null)).toBeNull();
    expect(
      readLastBot(memoryStorage({ [LAST_BOT_STORAGE_KEY]: " \n" })),
    ).toBeNull();
  });

  test("surrounding whitespace is trimmed off a stored id", () => {
    expect(parseStoredLastBot("  assistant ")).toBe("assistant");
  });

  /*
   * A private window can throw on the access itself. The conversation that triggered the write is
   * already open and the read has a fallback, so neither may surface the exception.
   */
  test("a storage that throws is tolerated on both sides", () => {
    expect(() => rememberLastBot("assistant", brokenStorage)).not.toThrow();
    expect(readLastBot(brokenStorage)).toBeNull();
  });

  test("with no storage given, resolving the default never throws", () => {
    // Under bun there may be no `window` at all, or a happy-dom one left registered by another
    // file in the same process. Either way the default resolution must fail — or succeed —
    // inside the same guard a blocked storage hits, so only the absence of a throw is asserted.
    expect(() => rememberLastBot("assistant")).not.toThrow();
    expect(() => readLastBot()).not.toThrow();
  });
});
