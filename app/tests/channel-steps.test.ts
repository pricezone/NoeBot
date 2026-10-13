import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  channelStep,
  nextStep,
  noteChannelStep,
  readWaiting,
  reportStep,
  subscribeToChannelSteps,
} from "@/lib/channels/steps";
import { parseChannelSocketMessage } from "@/lib/channels/use-channel-events";

/**
 * The moments of a turn, from the tab running it to the person's other tabs: each run starting and
 * ending, and each card that starts waiting on the person, as a step on the busy signal. A watching
 * tab acts on a step it has not seen; the tab that sent it does not act on its own.
 */

let sent: { path: string; body: unknown }[] = [];
let original: typeof fetch;
beforeEach(() => {
  sent = [];
  original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push({
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(null, { status: 204 });
    },
    { preconnect: original.preconnect },
  ) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

describe("steps", () => {
  test("a step only ever rises, and is never behind the clock", () => {
    const first = nextStep();
    const second = nextStep();
    expect(second).toBeGreaterThan(first);
    expect(first).toBeGreaterThanOrEqual(Date.now() - 5);
  });

  test("reporting a step sends it on the busy signal with the waiting card", async () => {
    const step = reportStep("steps-channel", true, {
      kind: "choice",
      toolCallId: "call-1",
    });
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toContain("/api/channels/steps-channel/busy");
    expect(sent[0]?.body).toEqual({
      busy: true,
      step,
      waiting: { kind: "choice", toolCallId: "call-1" },
    });
  });

  test("a step heard from another tab is news once; this tab's own step coming back is not", () => {
    const heard: number[] = [];
    const unsubscribe = subscribeToChannelSteps(() => {
      const latest = channelStep("steps-watch");
      if (latest) heard.push(latest.step);
    });
    try {
      const own = reportStep("steps-watch", true);
      noteChannelStep("steps-watch", { step: own, busy: true });
      expect(heard).toEqual([]);

      noteChannelStep("steps-watch", {
        step: 42,
        busy: true,
        waiting: { kind: "secret", toolCallId: "call-9" },
      });
      noteChannelStep("steps-watch", { step: 42, busy: true });
      expect(heard).toEqual([42]);
      expect(channelStep("steps-watch")?.waiting).toEqual({
        kind: "secret",
        toolCallId: "call-9",
      });
    } finally {
      unsubscribe();
    }
  });

  test("a waiting card off the wire is read only when it names a known kind and a call", () => {
    expect(readWaiting({ kind: "approval", toolCallId: "c" })).toEqual({
      kind: "approval",
      toolCallId: "c",
    });
    expect(readWaiting({ kind: "form", toolCallId: "c" })).toBeUndefined();
    expect(readWaiting({ kind: "help" })).toBeUndefined();
    expect(readWaiting(null)).toBeUndefined();
  });

  test("a busy event carrying a step parses as an ordinary channel event", () => {
    expect(
      parseChannelSocketMessage(
        JSON.stringify({
          channelId: "c",
          lastMessage: null,
          lastMessageAt: null,
          lastMessageAgentId: null,
          busy: true,
          step: 7,
          waiting: { kind: "help", toolCallId: "call-h" },
        }),
      ),
    ).toMatchObject({ busy: true, step: 7 });
  });
});
