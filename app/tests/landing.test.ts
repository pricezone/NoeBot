import { describe, expect, test } from "bun:test";
import {
  ASSISTANT_AGENT_ID,
  PICKED_HARNESS_AGENT_ID,
} from "@/lib/agents/default-agent";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import { landingTarget } from "@/lib/landing";

function agent(id: string): AgentProfile {
  return {
    avatarSeed: id,
    builtIn: id === ASSISTANT_AGENT_ID,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    id,
    mine: true,
    name: id,
    roleDescription: "Role",
    systemOwned: false,
    title: id,
    visibility: "private",
  };
}

/** A roster row, in the order the server hands them out: the first is the newest. */
function channel(id: string, agentIds: string[]): ChannelSummary {
  return {
    id,
    name: id,
    agentIds,
    threadId: `thread-${id}`,
    active: true,
    lastMessageAt: null,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
}

describe("landing target", () => {
  test("the newest conversation with the remembered Bot wins", () => {
    expect(
      landingTarget({
        lastBotId: "researcher",
        channels: [
          channel("c3", [ASSISTANT_AGENT_ID]),
          channel("c2", ["researcher"]),
          channel("c1", ["researcher"]),
        ],
        agents: [agent(ASSISTANT_AGENT_ID), agent("researcher")],
      }),
    ).toEqual({ to: "/channel/$channelId", params: { channelId: "c2" } });
  });

  test("with nothing remembered, the newest conversation with one Bot wins", () => {
    expect(
      landingTarget({
        lastBotId: null,
        channels: [channel("c2", ["researcher"]), channel("c1", ["writer"])],
        agents: [agent("researcher"), agent("writer")],
      }),
    ).toEqual({ to: "/channel/$channelId", params: { channelId: "c2" } });
  });

  /*
   * The remembered id is a lookup key, not a destination: a Bot since deleted, or an id from
   * another workspace, matches nothing and the next rule applies. It must never produce a
   * `/channel/new` for a Bot the roster does not list while real conversations exist.
   */
  test("a remembered Bot with no conversation falls back to the newest conversation", () => {
    expect(
      landingTarget({
        lastBotId: "gone",
        channels: [channel("c2", ["researcher"]), channel("c1", ["writer"])],
        agents: [agent("researcher"), agent("writer")],
      }),
    ).toEqual({ to: "/channel/$channelId", params: { channelId: "c2" } });
  });

  test("group conversations are never a landing", () => {
    expect(
      landingTarget({
        lastBotId: "researcher",
        channels: [
          channel("group", ["researcher", "writer"]),
          channel("c1", ["writer"]),
        ],
        agents: [agent("researcher"), agent("writer")],
      }),
    ).toEqual({ to: "/channel/$channelId", params: { channelId: "c1" } });
  });

  test("with no conversations, a fresh one with the default coworker", () => {
    expect(
      landingTarget({
        lastBotId: null,
        channels: [],
        agents: [agent("researcher"), agent(ASSISTANT_AGENT_ID)],
      }),
    ).toEqual({ to: "/channel/new", search: { agent: ASSISTANT_AGENT_ID } });

    // The same order `defaultAgentProfile` keeps: the package pick outranks Noë.
    expect(
      landingTarget({
        lastBotId: null,
        channels: [],
        agents: [agent(ASSISTANT_AGENT_ID), agent(PICKED_HARNESS_AGENT_ID)],
      }),
    ).toEqual({
      to: "/channel/new",
      search: { agent: PICKED_HARNESS_AGENT_ID },
    });
  });

  test("only group conversations is the same as none", () => {
    expect(
      landingTarget({
        lastBotId: null,
        channels: [channel("group", ["researcher", "writer"])],
        agents: [agent(ASSISTANT_AGENT_ID)],
      }),
    ).toEqual({ to: "/channel/new", search: { agent: ASSISTANT_AGENT_ID } });
  });

  test("nothing to land on gives null", () => {
    // No roster loaded: "cannot say" rather than a guess.
    expect(
      landingTarget({ lastBotId: null, channels: [], agents: undefined }),
    ).toBeNull();
    expect(
      landingTarget({ lastBotId: "x", channels: undefined, agents: undefined }),
    ).toBeNull();
    // A roster that loaded empty has no default coworker to name.
    expect(
      landingTarget({ lastBotId: null, channels: [], agents: [] }),
    ).toBeNull();
  });
});
