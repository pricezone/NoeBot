import { afterEach, describe, expect, test } from "bun:test";
import {
  beginRunTiming,
  endRunTiming,
  newRunTiming,
  recordPhase,
  resetRunTimingForTests,
  serverTimingHeader,
  timed,
  timedFetch,
  withRequestTiming,
} from "../src/run-timing";

afterEach(resetRunTimingForTests);

describe("per-run timing", () => {
  test("the request half is claimed by the run its request starts, and logged as one line", async () => {
    const request = newRunTiming();
    await withRequestTiming(request, async () => {
      await timed("agent_build", async () => undefined);
      recordPhase("lock", 42, "thread-1");
      recordPhase("history", 7, "thread-1");
    });
    const run = beginRunTiming("thread-1", "run-1");
    expect(run).toBe(request);
    recordPhase("model.ttft", 640, "thread-1");
    recordPhase("tool.computer_click", 900, "thread-1");
    const lines: string[] = [];
    endRunTiming(run, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[timing\] run=run-1 thread=thread-1 total=\d+ phases=agent_build:\d+,lock:42,history:7,model\.ttft:640,tool\.computer_click:900$/,
    );
  });

  test("a phase outside any request or run is dropped, never thrown", () => {
    expect(() => recordPhase("model.ttft", 5, "nobody")).not.toThrow();
  });

  test("a run with no request half still gets a line of its own", () => {
    const run = beginRunTiming("thread-2", "run-2");
    recordPhase("model.total", 1200, "thread-2");
    const lines: string[] = [];
    endRunTiming(run, (line) => lines.push(line));
    expect(lines[0]).toContain("phases=model.total:1200");
    // Ended: later phases on that thread go nowhere.
    recordPhase("model.total", 1, "thread-2");
  });

  test("Server-Timing names each request phase once, summed", () => {
    const timing = newRunTiming();
    timing.phases.push(
      { name: "history", ms: 10 },
      { name: "lock", ms: 5 },
      { name: "history", ms: 15 },
    );
    expect(serverTimingHeader(timing)).toBe("history;dur=25, lock;dur=5");
    expect(serverTimingHeader(newRunTiming())).toBeUndefined();
  });

  test("a runtime request is answered with a Server-Timing header; others are untouched", async () => {
    const timedResponse = await timedFetch(
      new Request("http://local/api/copilotkit/agent/bot/run", {
        method: "POST",
      }),
      async () => {
        recordPhase("lock", 12, "thread-3");
        return Response.json({ ok: true });
      },
    );
    expect(timedResponse.headers.get("Server-Timing")).toBe("lock;dur=12");
    const plain = await timedFetch(
      new Request("http://local/api/channels"),
      async () => {
        recordPhase("lock", 12, "thread-4");
        return Response.json({ ok: true });
      },
    );
    expect(plain.headers.get("Server-Timing")).toBeNull();
  });
});
