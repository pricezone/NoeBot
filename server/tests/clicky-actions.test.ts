import { describe, expect, test } from "bun:test";
import type { ClickyAction, ClickyProposal } from "../../shared/clicky";
import type { ComputerControlState } from "../../shared/computer-control";
import type { AuditEventInput } from "../src/audit";
import { CLICKY_HELP_REASON, createClickyActions } from "../src/clicky/actions";
import type { ActionPolicy } from "../src/computer/policy";
import type {
  ElementAtResult,
  HumanInput,
  ScreenElements,
} from "../src/computer/schema";
import { createExpoPushTransport, mobileLinkBase } from "../src/delivery/push";

/*
 * What Clicky does once the person said yes: it looks again, refuses what has become the person's to
 * do or what a deny rule forbids, takes the computer as the person when nobody holds it, and acts
 * through the person's own input path, in screen pixels on a desktop.
 */

const desktop: ScreenElements = {
  screen: { width: 1440, height: 900 },
  mode: "desktop",
  url: "https://shop.example/cart",
  elements: [
    {
      ref: "e1",
      role: "button",
      name: "Continue",
      rect: { x: 100, y: 100, width: 100, height: 40 },
      sensitive: false,
      focused: false,
    },
  ],
};

function proposalOf(
  action: ClickyAction,
  risk: ClickyProposal["risk"] = "low",
): ClickyProposal {
  return {
    id: "p1",
    action,
    why: "to go on",
    risk,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

const control = (
  holder: "bot" | "human",
  request?: "waiting",
): ComputerControlState => ({
  holder,
  since: "2026-10-14T00:00:00.000Z",
  requested: Boolean(request),
  ...(request
    ? {
        request: {
          id: "bot-request",
          reason: "help",
          source: "model",
          status: "waiting",
          createdAt: "2026-10-14T00:00:00.000Z",
          updatedAt: "2026-10-14T00:00:00.000Z",
        },
      }
    : {}),
  transitioning: false,
  resumeSnapshotRequired: false,
});

function fakeGateway(options: {
  screen?: ScreenElements;
  at?: Partial<ElementAtResult>;
  holder?: "bot" | "human";
  waiting?: boolean;
  policy?: ActionPolicy;
}) {
  const calls: string[] = [];
  const inputs: HumanInput[] = [];
  return {
    calls,
    inputs,
    gateway: {
      elements: async () => options.screen ?? desktop,
      elementAt: async () => ({
        role: "button",
        name: "Continue",
        sensitive: false,
        inPage: true,
        url: "https://shop.example/cart",
        ref: "e1",
        ...options.at,
      }),
      control: async () =>
        control(
          options.holder ?? "bot",
          options.waiting ? "waiting" : undefined,
        ),
      requestHelp: async (_botId: string, _actor: unknown, reason: string) => {
        calls.push(`requestHelp:${reason}`);
        return {
          ...control("bot"),
          request: {
            id: "clicky-request",
            reason,
            source: "model" as const,
            status: "waiting" as const,
            createdAt: "",
            updatedAt: "",
          },
        };
      },
      takeControl: async (_botId: string, _actor: unknown, id: string) => {
        calls.push(`take:${id}`);
        return control("human");
      },
      humanInput: async (_botId: string, input: HumanInput) => {
        inputs.push(input);
        return { action: "human_click" as const, url: "" };
      },
      actionPolicy: () => options.policy,
    },
  };
}

const run = (
  gateway: ReturnType<typeof fakeGateway>["gateway"],
  action: ClickyAction,
  extra: {
    risk?: ClickyProposal["risk"];
    signal?: AbortSignal;
    audits?: AuditEventInput[];
  } = {},
) =>
  createClickyActions({
    gateway,
    ...(extra.audits
      ? {
          auditStore: {
            insert: async (row: AuditEventInput) => {
              extra.audits?.push(row);
            },
          },
        }
      : {}),
  }).run({
    userId: "user-1",
    botId: "bot-1",
    proposal: proposalOf(action, extra.risk),
    actionPolicy: "ask_each",
    trigger: null,
    signal: extra.signal ?? new AbortController().signal,
  });

const clickContinue: ClickyAction = {
  kind: "click",
  at: { x: 0.1, y: 0.1333 },
  ref: "e1",
  label: "Continue",
};

describe("createClickyActions", () => {
  test("takes the computer as the person, then clicks in screen pixels on a desktop", async () => {
    const fake = fakeGateway({});
    expect(await run(fake.gateway, clickContinue)).toEqual({ ok: true });
    expect(fake.calls).toEqual([
      `requestHelp:${CLICKY_HELP_REASON}`,
      "take:clicky-request",
    ]);
    expect(fake.inputs).toEqual([
      { kind: "click", x: 144, y: 120, space: "screen" },
    ]);
  });

  test("takes the Bot's own waiting request rather than opening another, and nothing when the person holds it", async () => {
    const waiting = fakeGateway({ waiting: true });
    await run(waiting.gateway, clickContinue);
    expect(waiting.calls).toEqual(["take:bot-request"]);
    const held = fakeGateway({ holder: "human" });
    await run(held.gateway, clickContinue);
    expect(held.calls).toEqual([]);
    expect(held.inputs).toHaveLength(1);
  });

  test("on a page-only computer, types in page pixels after clicking the field", async () => {
    const fake = fakeGateway({
      screen: {
        ...desktop,
        mode: "page",
        screen: { width: 1000, height: 500 },
      },
      at: { role: "textbox", name: "Search" },
    });
    await run(fake.gateway, {
      kind: "type",
      text: "pizza",
      at: { x: 0.5, y: 0.5 },
      label: "Search",
    });
    expect(fake.inputs).toEqual([
      { kind: "click", x: 500, y: 250 },
      { kind: "type", text: "pizza" },
    ]);
  });

  test("refuses when the field turned out to hold a secret, and records it", async () => {
    const audits: AuditEventInput[] = [];
    const fake = fakeGateway({
      at: { role: "textbox", name: "[sensitive field]", sensitive: true },
    });
    const outcome = await run(
      fake.gateway,
      { kind: "type", text: "hunter2", at: { x: 0.5, y: 0.5 }, label: "it" },
      { audits },
    );
    expect(outcome.ok).toBe(false);
    expect(fake.calls).toEqual([]);
    expect(fake.inputs).toEqual([]);
    expect(audits.map((row) => row.eventType)).toEqual([
      "clicky.action_blocked",
    ]);
    expect(JSON.stringify(audits)).not.toContain("hunter2");
  });

  test("refuses when what is there now is riskier than what the person said yes to", async () => {
    const fake = fakeGateway({ at: { name: "Submit order now" } });
    const outcome = await run(fake.gateway, clickContinue, { risk: "low" });
    expect(outcome).toEqual({
      ok: false,
      detail: expect.any(String),
    });
    expect(fake.inputs).toEqual([]);
    // Said yes to a confirm: a confirm still runs.
    const confirmed = fakeGateway({ at: { name: "Send" } });
    expect(
      await run(confirmed.gateway, clickContinue, { risk: "confirm" }),
    ).toEqual({ ok: true });
  });

  test("a deny rule refuses the person's action too; a dry run lets it through", async () => {
    const deny = 'contains(element.name, "Continue")';
    const enforced = fakeGateway({
      policy: { mode: "enforce", deny: [deny], allow: [] },
    });
    const outcome = await run(enforced.gateway, clickContinue);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.detail).toContain("Continue");
    expect(enforced.inputs).toEqual([]);
    // An allow list that permits nothing does not stop the person's own input.
    const allowNothing = fakeGateway({
      policy: { mode: "enforce", deny: [], allow: [] },
    });
    expect(await run(allowNothing.gateway, clickContinue)).toEqual({
      ok: true,
    });
    const dryRun = fakeGateway({
      policy: { mode: "dry-run", deny: [deny], allow: [] },
    });
    expect(await run(dryRun.gateway, clickContinue)).toEqual({ ok: true });
  });

  test("stopped before acting, nothing is sent", async () => {
    const fake = fakeGateway({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(fake.gateway, clickContinue, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(fake.inputs).toEqual([]);
  });

  test("keys and scrolls go in screen space on a desktop", async () => {
    const fake = fakeGateway({ holder: "human" });
    await run(fake.gateway, { kind: "key", keys: "Tab", label: "Tab" });
    await run(fake.gateway, {
      kind: "scroll",
      at: { x: 0.5, y: 0.5 },
      deltaY: 400,
      label: "down",
    });
    expect(fake.inputs).toEqual([
      { kind: "key", key: "Tab", space: "screen" },
      { kind: "scroll", deltaY: 400, x: 720, y: 450, space: "screen" },
    ]);
  });
});

describe("the push for Clicky", () => {
  test("links to the Bot's Clicky under the configured base", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const push = createExpoPushTransport({
      linkBase: "hypernoesis://noebot/",
      fetch: async (url, init) => {
        sent.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({ data: { status: "ok", id: "ticket-1" } });
      },
    });
    await push.send({
      token: "ExponentPushToken[abc]",
      title: "Noë Bot needs you",
      body: "Please sign in",
      kind: "clicky",
      botId: "bot 1",
      requestId: "r1",
    });
    expect(sent[0]?.body.data).toEqual({
      botId: "bot 1",
      kind: "clicky",
      requestId: "r1",
      url: "hypernoesis://noebot/clicky?bot=bot+1&requestId=r1",
    });
  });

  test("the base defaults to the OpenBot app's scheme", () => {
    expect(mobileLinkBase({})).toBe("openbotmobile://");
    expect(mobileLinkBase({ OPENBOT_MOBILE_LINK_BASE: "  " })).toBe(
      "openbotmobile://",
    );
    expect(
      mobileLinkBase({ OPENBOT_MOBILE_LINK_BASE: "hypernoesis://noebot/" }),
    ).toBe("hypernoesis://noebot/");
  });
});
