import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { ApprovalGate } from "../src/approvals/types";
import type { AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  type ComputerBotAction,
  type ComputerControlEvent,
  type ComputerGateway,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";
import type { SnapshotResult } from "../src/computer/schema";

/*
 * The gateway's side of Show me how: it tells who is listening what the Bot is about to do on its
 * page (and nothing about shell or file calls, nothing on an approval's replay, never the text), it
 * says when a person's Take control is their own, and it reaches the computer's new reads and the
 * scroll to a step only with a ref that is a ref.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://gov.example/form",
  title: "Form",
  truncated: false,
  elements: [
    { ref: "e1", role: "textbox", name: "Surname" },
    { ref: "e9", role: "button", name: "Continue" },
  ],
};

const ALLOW: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const ACTOR = { id: "user-1", userId: "user-1" };

function computer() {
  const paths: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => "http://agent-computer:4100",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const { pathname, search } = new URL(url);
    paths.push(`${pathname}${search}`);
    if (init?.body)
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    switch (pathname) {
      case "/snapshot":
        return Response.json(SNAPSHOT);
      case "/control/request":
        return Response.json({
          holder: "bot",
          since: "",
          requested: true,
          transitioning: false,
          resumeSnapshotRequired: false,
        });
      case "/elements/ref":
        return Response.json({
          screen: { width: 1000, height: 500 },
          rect: { x: 1, y: 2, width: 3, height: 4 },
        });
      default:
        return Response.json({ action: "ok", url: SNAPSHOT.url });
    }
  }) as unknown as typeof fetch;
  return { provider, fetchImpl, paths, bodies };
}

async function gatewayWith(
  options: {
    approvalGate?: ApprovalGate;
    onBotAction?: (event: ComputerBotAction) => void;
    onControlEvent?: (event: ComputerControlEvent) => void;
  } = {},
) {
  const fake = computer();
  const auditStore: AuditStore = { insert: async () => undefined };
  const gateway = createComputerGateway({
    provider: fake.provider,
    fetchImpl: fake.fetchImpl,
    auditStore,
    policy: () => ALLOW,
    ...options,
  });
  await gateway.snapshot("bot-1");
  return { gateway, ...fake };
}

describe("onBotAction", () => {
  test("hears each page action once it is decided, before it is sent, and never the text", async () => {
    const heard: { event: ComputerBotAction; sentBefore: number }[] = [];
    const fake = await gatewayWith({
      onBotAction: (event) =>
        heard.push({ event, sentBefore: fakePaths().length }),
    });
    const fakePaths = () =>
      fake.paths.filter((path) => path === "/type" || path === "/navigate");
    await fake.gateway.type("bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "Παπαδοπούλου",
    });
    await fake.gateway.navigate("bot-1", ACTOR, "https://www.gov.gr/");
    expect(heard.map((entry) => entry.event)).toEqual([
      {
        botId: "bot-1",
        userId: "user-1",
        tool: "computer_type",
        ref: "e1",
        snapshotId: 7,
        role: "textbox",
        name: "Surname",
        url: "https://gov.example/form",
        characters: 12,
      },
      {
        botId: "bot-1",
        userId: "user-1",
        tool: "computer_navigate",
        url: "https://www.gov.gr/",
      },
    ]);
    // Told before the computer was asked, each time.
    expect(heard.map((entry) => entry.sentBefore)).toEqual([0, 1]);
    expect(JSON.stringify(heard)).not.toContain("Παπαδοπούλου");
  });

  test("not for shell or file calls, not for a refused action, not for an approval's replay", async () => {
    const heard: ComputerBotAction[] = [];
    const replaying: ApprovalGate = async () => ({
      replay: { action: "click", url: SNAPSHOT.url },
      complete: async () => undefined,
    });
    const replayed = await gatewayWith({
      approvalGate: replaying,
      onBotAction: (event) => heard.push(event),
    });
    await replayed.gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 });
    expect(replayed.paths).not.toContain("/click");

    const plain = await gatewayWith({
      onBotAction: (event) => heard.push(event),
    });
    await plain.gateway.runCommand("bot-1", ACTOR, { command: "ls" });
    await plain.gateway.writeFile("bot-1", ACTOR, {
      path: "notes.md",
      contents: "x",
    });
    await plain.gateway
      .click("bot-1", ACTOR, { ref: "e404", snapshotId: 7 })
      .catch(() => undefined);
    expect(heard).toEqual([]);
  });

  test("a fill is heard by its first field", async () => {
    const heard: ComputerBotAction[] = [];
    const fake = await gatewayWith({
      onBotAction: (event) => heard.push(event),
    });
    await fake.gateway.fill("bot-1", ACTOR, {
      snapshotId: 7,
      fields: [{ ref: "e1", text: "Maria" }],
    });
    expect(heard).toEqual([
      {
        botId: "bot-1",
        userId: "user-1",
        tool: "computer_fill",
        ref: "e1",
        snapshotId: 7,
        role: "textbox",
        name: "Surname",
        url: "https://gov.example/form",
      },
    ]);
  });

  test("a listener that throws costs the action nothing", async () => {
    const fake = await gatewayWith({
      onBotAction: () => {
        throw new Error("listener down");
      },
    });
    await fake.gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 });
    expect(fake.paths).toContain("/click");
  });
});

describe("Show me how's reads and the person's own Take control", () => {
  test("a manual request says so to the computer and to the listener", async () => {
    const events: ComputerControlEvent[] = [];
    const fake = await gatewayWith({
      onControlEvent: (event) => events.push(event),
    });
    await fake.gateway.requestHelp("bot-1", ACTOR, "Mine now.", undefined, {
      source: "manual",
    });
    await fake.gateway.requestHelp("bot-1", ACTOR, "Please sign in.");
    expect(fake.bodies.filter((body) => "reason" in body)).toEqual([
      { reason: "Mine now.", source: "manual" },
      { reason: "Please sign in." },
    ]);
    expect(events.map((event) => event.source)).toEqual(["manual", undefined]);
  });

  test("a ref reaches the computer only when it is a ref", async () => {
    const fake = await gatewayWith();
    expect(await fake.gateway.elementRect("bot-1", "e9", 7)).toEqual({
      screen: { width: 1000, height: 500 },
      rect: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(await fake.gateway.elementRect("bot-1", "../exec?x=", 7)).toEqual({
      rect: null,
    });
    expect(
      fake.paths.filter((path) => path.startsWith("/elements/ref")),
    ).toEqual(["/elements/ref?ref=e9&snapshotId=7"]);
    await fake.gateway.humanInput("bot-1", {
      kind: "scroll-into-view",
      ref: "e40",
    });
    expect(fake.paths).toContain("/human/scroll-into-view");
    await expect(
      fake.gateway.humanInput("bot-1", {
        kind: "scroll-into-view",
        ref: "e40/../../exec",
      }),
    ).rejects.toThrow("ref");
  });

  test("going to a site reaches the computer only for an https address the target guard allows", async () => {
    const fake = await gatewayWith();
    await fake.gateway.humanInput("bot-1", {
      kind: "open",
      url: "https://www.gov.gr/",
    });
    expect(fake.paths).toContain("/human/open");
    for (const url of [
      "http://www.gov.gr/",
      "javascript:alert(1)",
      "https://user:pw@www.gov.gr/",
      "https://127.0.0.1/admin",
      "https://169.254.169.254/latest/meta-data",
    ])
      await expect(
        fake.gateway.humanInput("bot-1", { kind: "open", url }),
      ).rejects.toThrow();
    expect(fake.paths.filter((path) => path === "/human/open")).toHaveLength(1);
  });
});

describe("POST /:botId/control/request", () => {
  const asPerson: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role: "user",
    });
    await next();
  };

  test("takes source manual from the person's client, and no other source", async () => {
    const asked: unknown[] = [];
    const gateway = {
      requestHelp: async (
        _botId: string,
        _actor: unknown,
        reason: string,
        _toolCallId?: string,
        options?: unknown,
      ) => {
        asked.push({ reason, options });
        return { holder: "bot", requested: true };
      },
    } as unknown as ComputerGateway;
    const app = new Hono<{ Variables: AppVariables }>().route(
      "/api/computers",
      createComputerRoutes(
        gateway,
        {} as PolicyStore,
        asPerson,
        async () => true,
      ),
    );
    const post = (body: unknown) =>
      app.request("http://openbot.test/api/computers/bot-1/control/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await post({ reason: "Mine.", source: "manual" });
    await post({ reason: "Pretend.", source: "cloudflare" });
    await post({ reason: "Here.", pointAt: "e3", source: "manual" });
    expect(asked).toEqual([
      { reason: "Mine.", options: { source: "manual" } },
      { reason: "Pretend.", options: undefined },
      { reason: "Here.", options: { pointAt: "e3", source: "manual" } },
    ]);
  });
});
