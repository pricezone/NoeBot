import { describe, expect, test } from "bun:test";
import {
  historyOrEmpty,
  isMissingThread,
  isPassingPlatformFailure,
  PLATFORM_RETRY_DELAYS_MS,
  withPlatformRetry,
} from "../src/copilot";

/**
 * Reading history on a thread the platform has never seen.
 *
 * A thread id is minted before the thread exists, so this is the opening move of every new
 * conversation and it was answering 500. The decision is the whole of the change, and it is tested
 * here against the real functions rather than a copy of them: the previous attempt (#71) tested a
 * re-implementation of its own middleware, which passes with the shipped code deleted.
 */

/**
 * A `PlatformRequestError` as the platform client constructs one.
 *
 * Built by hand because the class is not re-exported from `@copilotkit/runtime/v2` and the package's
 * `exports` map reaches nothing that holds it — which is also why the code under test matches on the
 * shape. The constructor sets the message, then `status`, then `name`, so this is the same object.
 */
function platformError(status: number): Error {
  const error = new Error(`Intelligence platform error ${status}`);
  error.name = "PlatformRequestError";
  (error as Error & { status: number }).status = status;
  return error;
}

describe("recognising a thread the platform does not have", () => {
  test("a 404 from the platform is a missing thread", () => {
    expect(isMissingThread(platformError(404))).toBe(true);
  });

  test("a 500 from the platform is not", () => {
    // The one that matters. An outage answered with an empty history tells the browser the
    // conversation is gone and invites somebody to start it over.
    expect(isMissingThread(platformError(500))).toBe(false);
  });

  test("a 403 from the platform is not", () => {
    // A bad key is not an absent thread, and reading it as one would hide a misconfiguration behind
    // a conversation that looks new.
    expect(isMissingThread(platformError(403))).toBe(false);
  });

  test("an unrelated error carrying a 404 is not", () => {
    /*
     * Both halves are checked, so something else with a `status` of 404 on it — a fetch wrapper, a
     * vendor SDK — does not get a thread's history replaced with nothing.
     */
    const other = new Error("some other failure");
    (other as Error & { status: number }).status = 404;
    expect(isMissingThread(other)).toBe(false);
  });

  test("a plain object shaped like one is not", () => {
    expect(isMissingThread({ name: "PlatformRequestError", status: 404 })).toBe(
      false,
    );
  });

  test("nothing thrown at all is not", () => {
    expect(isMissingThread(undefined)).toBe(false);
    expect(isMissingThread(null)).toBe(false);
  });
});

describe("reading a history that may not exist yet", () => {
  const empty = { messages: [] as string[] };

  test("a thread with history returns it", async () => {
    const history = { messages: ["hello"] };
    expect(await historyOrEmpty(async () => history, empty)).toBe(history);
  });

  test("a thread the platform does not have reads as empty", async () => {
    expect(
      await historyOrEmpty(async () => {
        throw platformError(404);
      }, empty),
    ).toEqual({ messages: [] });
  });

  test("a platform outage still throws", async () => {
    // Not swallowed, not turned into an empty conversation. This is the assertion that would fail if
    // the branch were widened to any failure.
    await expect(
      historyOrEmpty(async () => {
        throw platformError(500);
      }, empty),
    ).rejects.toThrow("Intelligence platform error 500");
  });

  test("an error that is not the platform's still throws", async () => {
    await expect(
      historyOrEmpty(async () => {
        throw new Error("the network went away");
      }, empty),
    ).rejects.toThrow("the network went away");
  });
});

describe("asking the platform again", () => {
  const noWait = { sleep: async () => {} };

  test("a 502 then an answer is the answer", async () => {
    let calls = 0;
    const answer = await withPlatformRetry(async () => {
      calls += 1;
      if (calls < 3) throw platformError(502);
      return "locked for you";
    }, noWait);

    expect(answer).toBe("locked for you");
    expect(calls).toBe(3);
  });

  test("a network failure before any answer is asked again", async () => {
    let calls = 0;
    const answer = await withPlatformRetry(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return 1;
    }, noWait);

    expect(answer).toBe(1);
  });

  test("a 409 is waited out only where it was asked for", async () => {
    let calls = 0;
    const attempt = async () => {
      calls += 1;
      if (calls === 1) throw platformError(409);
      return "ok";
    };

    await expect(withPlatformRetry(attempt, noWait)).rejects.toThrow("409");
    calls = 0;
    expect(
      await withPlatformRetry(attempt, {
        ...noWait,
        statuses: new Set([409]),
      }),
    ).toBe("ok");
  });

  test("a 404 or a 401 is not asked again", async () => {
    for (const status of [404, 401, 500]) {
      let calls = 0;
      await expect(
        withPlatformRetry(async () => {
          calls += 1;
          throw platformError(status);
        }, noWait),
      ).rejects.toThrow(String(status));
      expect(calls).toBe(1);
    }
  });

  test("it gives up when the delays run out, with the last failure", async () => {
    let calls = 0;
    const waited: number[] = [];
    await expect(
      withPlatformRetry(
        async () => {
          calls += 1;
          throw platformError(503);
        },
        {
          delaysMs: [1, 2],
          sleep: async (ms) => {
            waited.push(ms);
          },
        },
      ),
    ).rejects.toThrow("503");
    expect(calls).toBe(3);
    expect(waited).toEqual([1, 2]);
  });

  test("the delays add up to about sixteen seconds", () => {
    expect(PLATFORM_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(15750);
    expect(isPassingPlatformFailure(platformError(429))).toBe(true);
  });
});
