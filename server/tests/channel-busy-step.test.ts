import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  type ChannelActivityEvent,
  createChannelEventHub,
} from "../src/channels/events";
import { type ChannelStore, createChannelRoutes } from "../src/channels/routes";

/**
 * A person's tab says each moment of its turn: a run starting, a run ending, a card starting to wait
 * on them. The busy signal carries that moment as a step (and the waiting card), so the person's
 * other tabs can read the conversation again right then, instead of after the whole turn.
 */

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "user-1",
    email: "user@openbot.test",
    role: "user",
  });
  await next();
};

function harness() {
  const calls: unknown[][] = [];
  const store = {
    signalChannelBusy: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as unknown as ChannelStore;
  const routes = createChannelRoutes(store, requireUser);
  const post = (body: unknown) =>
    routes.request("http://openbot.test/channel-1/busy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { calls, post };
}

describe("the busy signal's step", () => {
  test("carries the step and the waiting card to the store", async () => {
    const { calls, post } = harness();
    const response = await post({
      busy: true,
      step: 1_760_000_000_123,
      waiting: { kind: "choice", toolCallId: "call-7" },
    });
    expect(response.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(1)).toEqual([
      "channel-1",
      true,
      {
        step: 1_760_000_000_123,
        waiting: { kind: "choice", toolCallId: "call-7" },
      },
    ]);
  });

  test("a plain busy signal still works, with no step", async () => {
    const { calls, post } = harness();
    expect((await post({ busy: false })).status).toBe(204);
    expect(calls[0]?.slice(1)).toEqual(["channel-1", false, {}]);
  });

  test.each([
    ["a fractional step", { busy: true, step: 1.5 }],
    ["a negative step", { busy: true, step: -1 }],
    [
      "an unknown card kind",
      { busy: true, step: 2, waiting: { kind: "form", toolCallId: "x" } },
    ],
    [
      "a waiting card with no tool call",
      { busy: true, step: 2, waiting: { kind: "secret" } },
    ],
  ])("refuses %s", async (_name, body) => {
    const { calls, post } = harness();
    expect((await post(body)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("the hub fans the step and the waiting card out to every member's connections", () => {
    const hub = createChannelEventHub();
    const received: string[] = [];
    hub.register("user-1", (payload) => received.push(`user-1:${payload}`));
    hub.register("user-1", (payload) => received.push(`user-1b:${payload}`));
    hub.register("user-2", (payload) => received.push(`user-2:${payload}`));
    const event: ChannelActivityEvent = {
      channelId: "channel-1",
      memberIds: ["user-1"],
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      busy: true,
      step: 9,
      waiting: { kind: "secret", toolCallId: "call-9" },
    };
    hub.deliver(event);
    expect(received).toHaveLength(2);
    for (const line of received) {
      const payload = JSON.parse(line.slice(line.indexOf(":") + 1));
      expect(payload).toMatchObject({
        busy: true,
        step: 9,
        waiting: { kind: "secret", toolCallId: "call-9" },
      });
    }
  });
});
