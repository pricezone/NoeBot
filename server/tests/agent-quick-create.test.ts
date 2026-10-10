import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  FIRST_TURN_GREETING,
  FIRST_TURN_OPTIONS,
  FIRST_TURN_QUESTION,
  frameFirstTurn,
  isFirstTurn,
} from "../../shared/first-turn";
import { PUT_TO } from "../../shared/handoff-markers";
import { askTheirOwnPerson, escalationTool } from "../src/agents/escalation";
import {
  createFirstTurnStarter,
  type FirstTurnStarter,
  NEW_BOT,
} from "../src/agents/first-turn";
import type { AgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";
import { createAgentRoutes } from "../src/agents/routes";
import type { AppVariables } from "../src/auth/guards";
import type { AgentChannel } from "../src/channels/routes";
import { askedQuestion } from "../src/routines/run-turn";
import type { TurnRunner } from "../src/routines/runner";

/**
 * "Create new Bot" in one click: a Bot with defaults, its conversation with the person, and a first
 * turn in which the Bot speaks first. The turn runner is a fake here; what is pinned is what the
 * route hands it and what the starter does with what comes back.
 */

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent_new",
    name: NEW_BOT.name,
    title: NEW_BOT.title,
    roleDescription: NEW_BOT.roleDescription,
    avatarSeed: "agent_new",
    visibility: NEW_BOT.visibility,
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
}

const CHANNEL: AgentChannel = {
  id: "channel_new",
  name: NEW_BOT.name,
  agentIds: ["agent_new"],
  threadId: "thread_new",
  active: true,
  lastMessageAt: null,
};

function fakeStore(created: unknown[]): AgentProfileStore {
  const unused = async () => {
    throw new Error("Not used by a quick create.");
  };
  return {
    list: unused,
    get: unused,
    getWithin: unused,
    async create(_actor, input) {
      created.push(input);
      return profile();
    },
    update: unused,
    duplicate: unused,
    setHidden: unused,
    setPinned: unused,
    softDelete: unused,
    issueCallbackToken: unused,
    revokeCallbackToken: unused,
    agentForCallbackToken: unused,
  };
}

function appWith(quick?: Parameters<typeof createAgentRoutes>[8]) {
  const created: unknown[] = [];
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createAgentRoutes(
      fakeStore(created),
      requireUser,
      false,
      undefined,
      new Set(),
      undefined,
      true,
      undefined,
      quick,
    ),
  );
  return { app, created };
}

const post = (app: Hono<{ Variables: AppVariables }>, body: unknown) =>
  app.request("http://openbot.test/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/agents with quick", () => {
  test("makes New Bot and its conversation, answers with both, and starts the first turn", async () => {
    const opened: [AgentActor, string][] = [];
    const started: Parameters<FirstTurnStarter>[0][] = [];
    // The starter never settles, which is how the test knows the answer did not wait for the turn.
    const { app, created } = appWith({
      openChannel: async (receivedActor, agentId) => {
        opened.push([receivedActor, agentId]);
        return CHANNEL;
      },
      startFirstTurn: (input) => {
        started.push(input);
        return new Promise<void>(() => undefined);
      },
    });

    const response = await post(app, { quick: true });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      agent: { id: string; name: string };
      channel: Record<string, unknown>;
    };
    expect(body.agent).toMatchObject({ id: "agent_new", name: "New Bot" });
    expect(body.channel).toEqual({
      id: CHANNEL.id,
      name: CHANNEL.name,
      agentIds: CHANNEL.agentIds,
      threadId: CHANNEL.threadId,
      active: true,
      lastMessageAt: null,
    });
    // The defaults, and the role as what a Bot with no endpoint runs on.
    expect(created).toEqual([
      { ...NEW_BOT, systemPrompt: NEW_BOT.roleDescription },
    ]);
    expect(opened).toEqual([[actor, "agent_new"]]);
    expect(started).toEqual([
      { actor, agentId: "agent_new", channel: CHANNEL },
    ]);
  });

  test("a starter that rejects does not fail the create", async () => {
    const { app } = appWith({
      openChannel: async () => CHANNEL,
      startFirstTurn: () => Promise.reject(new Error("boom")),
    });

    expect((await post(app, { quick: true })).status).toBe(201);
  });

  test("is refused where there are no conversations to open", async () => {
    const { app, created } = appWith(undefined);

    const response = await post(app, { quick: true });

    expect(response.status).toBe(400);
    expect(created).toEqual([]);
  });

  test("anything but quick: true is still the form's create", async () => {
    const { app, created } = appWith({ openChannel: async () => CHANNEL });

    const response = await post(app, { quick: "yes" });

    // Validated as the form would be, and refused for the fields it lacks.
    expect(response.status).toBe(400);
    expect(created).toEqual([]);
  });
});

function fakeChannels() {
  const busy: boolean[] = [];
  const activity: { text: string; agentId: string | null }[] = [];
  return {
    busy,
    activity,
    channels: {
      async signalBusy(_threadId: string, value: boolean) {
        busy.push(value);
      },
      async recordActivity(
        _actor: AgentActor,
        _channelId: string,
        recorded: { text: string; agentId: string | null },
      ) {
        activity.push({ text: recorded.text, agentId: recorded.agentId });
      },
    },
  };
}

describe("the first turn", () => {
  test("runs the frame as the person's own turn and tells the roster the question it ended on", async () => {
    const calls: Parameters<TurnRunner>[0][] = [];
    const { busy, activity, channels } = fakeChannels();
    const start = createFirstTurnStarter({
      runTurn: async (input) => {
        calls.push(input);
        input.onText?.(FIRST_TURN_GREETING);
        return { replyText: FIRST_TURN_GREETING, asked: FIRST_TURN_QUESTION };
      },
      channels,
    });

    await start({ actor, agentId: "agent_new", channel: CHANNEL });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.ownerUserId).toBe(actor.id);
    expect(call?.agentId).toBe("agent_new");
    expect(call?.threadId).toBe(CHANNEL.threadId);
    expect(call?.initiator).toEqual({ kind: "person" });
    // The frame is the message itself, not a routine firing wrapped around it.
    expect(call?.userMessage).toMatchObject({
      role: "user",
      content: frameFirstTurn(),
    });
    expect(activity).toEqual([
      { text: FIRST_TURN_QUESTION, agentId: "agent_new" },
    ]);
    // Busy at the start, again once the Bot speaks, and cleared at the end.
    expect(busy).toEqual([true, true, false]);
  });

  test("a turn that asked nothing reports what it said", async () => {
    const { activity, channels } = fakeChannels();
    const start = createFirstTurnStarter({
      runTurn: async () => ({ replyText: "Hello there." }),
      channels,
    });

    await start({ actor, agentId: "agent_new", channel: CHANNEL });

    expect(activity).toEqual([{ text: "Hello there.", agentId: "agent_new" }]);
  });

  test("a failed turn is logged, never thrown, and still clears the working dot", async () => {
    const logged: Record<string, unknown>[] = [];
    const { busy, activity, channels } = fakeChannels();
    const start = createFirstTurnStarter({
      runTurn: async () => {
        throw new Error("The model is off the allowlist.");
      },
      channels,
      log: (event) => logged.push(event),
    });

    await start({ actor, agentId: "agent_new", channel: CHANNEL });

    expect(activity).toEqual([]);
    expect(busy).toEqual([true, false]);
    expect(logged[0]).toMatchObject({
      type: "first-turn-failed",
      reason: "The model is off the allowlist.",
    });
  });
});

describe("the frame", () => {
  test("asks for the greeting word for word and the question with its options", () => {
    const frame = frameFirstTurn();
    expect(frame).toContain(`"${FIRST_TURN_GREETING}"`);
    expect(frame).toContain(`"${FIRST_TURN_QUESTION}"`);
    for (const option of FIRST_TURN_OPTIONS) expect(frame).toContain(option);
    expect(frame).toContain("for the start of this conversation only");
  });

  test("is recognised, and a person's own words are not", () => {
    expect(isFirstTurn(frameFirstTurn())).toBe(true);
    expect(isFirstTurn("Research and writing")).toBe(false);
  });
});

describe("the question a turn ended on", () => {
  const call = (id: string, args: unknown): Message => ({
    id: `assistant-${id}`,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id,
        type: "function",
        function: { name: "ask_person", arguments: JSON.stringify(args) },
      },
    ],
  });
  const result = (id: string, content: string): Message => ({
    id: `tool-${id}`,
    role: "tool",
    toolCallId: id,
    content,
  });

  test("is the question of an ask_person call that reached somebody", () => {
    expect(
      askedQuestion([
        call("c1", { question: FIRST_TURN_QUESTION }),
        result("c1", JSON.stringify(`${PUT_TO}the person.`)),
      ]),
    ).toBe(FIRST_TURN_QUESTION);
  });

  test("is nothing when the question was refused", () => {
    expect(
      askedQuestion([
        call("c1", { question: FIRST_TURN_QUESTION }),
        result("c1", "That did not reach anybody."),
      ]),
    ).toBeUndefined();
  });
});

describe("ask_person with options", () => {
  test("accepts them and tells the Bot not to ask again in prose", async () => {
    const tool = escalationTool({
      from: {
        botId: "agent_new",
        actorId: actor.id,
        runId: "run-1",
        threadId: "thread_new",
        depth: 0,
      },
      route: askTheirOwnPerson,
    });

    const said = await tool.execute({
      question: FIRST_TURN_QUESTION,
      options: [...FIRST_TURN_OPTIONS],
    });

    expect(said).toStartWith(PUT_TO);
    expect(said).toContain("do not repeat it");
  });
});
