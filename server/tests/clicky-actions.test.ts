import { describe, expect, test } from "bun:test";
import type {
  ClickyAction,
  ClickyProposal,
  ClickySeen,
} from "../../shared/clicky";
import type { ComputerControlState } from "../../shared/computer-control";
import type { AuditEventInput } from "../src/audit";
import { CLICKY_HELP_REASON, createClickyActions } from "../src/clicky/actions";
import type { ActionPolicy } from "../src/computer/policy";
import type {
  ElementAtResult,
  FocusResult,
  HumanInput,
  ScreenElements,
} from "../src/computer/schema";
import { createExpoPushTransport, mobileLinkBase } from "../src/delivery/push";

/*
 * What Clicky does once the person said yes: it takes the computer as the person first (only when
 * nobody else holds it), then looks again, refuses what changed, what has become the person's to do
 * or what a deny rule forbids, and acts through the person's own input path, in screen pixels on a
 * desktop and only into the Bot's own window.
 */

const desktop: ScreenElements = {
  screen: { width: 1440, height: 900 },
  mode: "desktop",
  url: "https://shop.example/cart",
  elements: [],
};

function proposalOf(
  action: ClickyAction,
  risk: ClickyProposal["risk"] = "low",
  seen?: ClickySeen,
): ClickyProposal {
  return {
    id: "p1",
    action,
    why: "to go on",
    risk,
    ...(seen ? { seen } : {}),
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
  focus?: FocusResult;
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
      elements: async () => {
        calls.push("elements");
        return options.screen ?? desktop;
      },
      elementAt: async (
        _botId: string,
        _point: unknown,
        probe?: { verifyWindow?: boolean },
      ) => {
        calls.push(`elementAt${probe?.verifyWindow ? ":verify" : ""}`);
        return {
          role: "button",
          name: "Continue",
          sensitive: false,
          inPage: true,
          url: "https://shop.example/cart",
          ref: "e1",
          ...options.at,
        };
      },
      focus: async () => {
        calls.push("focus");
        return (
          options.focus ?? {
            window: "browser" as const,
            element: { role: "textbox", name: "Search", sensitive: false },
            url: "https://shop.example/cart",
          }
        );
      },
      control: async () => {
        calls.push("control");
        return control(
          options.holder ?? "bot",
          options.waiting ? "waiting" : undefined,
        );
      },
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
    seen?: ClickySeen;
    signal?: AbortSignal;
    audits?: AuditEventInput[];
    holder?: string | null;
    viaGrant?: boolean;
  } = {},
) =>
  createClickyActions({
    gateway,
    holderOf: () => ("holder" in extra ? extra.holder : "user-1"),
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
    proposal: proposalOf(action, extra.risk, extra.seen),
    actionPolicy: "ask_each",
    trigger: null,
    signal: extra.signal ?? new AbortController().signal,
    ...(extra.viaGrant ? { viaGrant: true } : {}),
  });

const clickContinue: ClickyAction = {
  kind: "click",
  at: { x: 0.1, y: 0.1333 },
  ref: "e1",
  label: "Continue (button)",
};

describe("createClickyActions", () => {
  test("takes the computer as the person first, then looks, then clicks only into the Bot's window", async () => {
    const fake = fakeGateway({});
    const outcome = await run(fake.gateway, clickContinue);
    expect(outcome).toEqual({
      ok: true,
      audit: {
        label: "Continue (button)",
        modelLabel: null,
        role: "button",
        name: "Continue",
        host: "shop.example",
      },
    });
    expect(fake.calls).toEqual([
      "control",
      `requestHelp:${CLICKY_HELP_REASON}`,
      "take:clicky-request",
      "elements",
      "elementAt:verify",
    ]);
    expect(fake.inputs).toEqual([
      {
        kind: "click",
        x: 144,
        y: 120,
        space: "screen",
        requireBrowser: true,
      },
    ]);
  });

  test("takes the Bot's own waiting request rather than opening another, and nothing more when this person holds it", async () => {
    const waiting = fakeGateway({ waiting: true });
    await run(waiting.gateway, clickContinue);
    expect(waiting.calls.slice(0, 2)).toEqual(["control", "take:bot-request"]);
    const held = fakeGateway({ holder: "human" });
    await run(held.gateway, clickContinue);
    expect(held.calls).not.toContain("take:clicky-request");
    expect(held.inputs).toHaveLength(1);
  });

  test("never acts while somebody else holds the computer, or while it cannot tell who does", async () => {
    for (const holder of ["user-2", "", undefined]) {
      const fake = fakeGateway({ holder: "human" });
      const outcome = await run(fake.gateway, clickContinue, { holder });
      expect(outcome.ok).toBe(false);
      expect(fake.inputs).toEqual([]);
      expect(fake.calls).toEqual(["control"]);
    }
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
    expect(fake.calls).toContain("elementAt");
    // Typed through the page's keyboard, once the field clicked has it.
    expect(fake.inputs).toEqual([
      { kind: "click", x: 500, y: 250 },
      { kind: "type", text: "pizza", keyboard: "page", at: { x: 500, y: 250 } },
    ]);
  });

  test("refuses when the page or the element changed since the person was asked", async () => {
    const seen = {
      url: "https://shop.example/cart",
      role: "button",
      name: "Continue",
    };
    const same = fakeGateway({});
    expect((await run(same.gateway, clickContinue, { seen })).ok).toBe(true);
    for (const at of [
      { name: "Delete account" },
      { url: "https://shop.example/checkout" },
    ]) {
      const audits: AuditEventInput[] = [];
      const changed = fakeGateway({ at });
      const outcome = await run(changed.gateway, clickContinue, {
        seen,
        audits,
      });
      expect(outcome.ok).toBe(false);
      expect(changed.inputs).toEqual([]);
      expect(audits[0]?.payload).toMatchObject({ reason: "changed" });
    }
  });

  test("the page is compared before every action, whatever has the keyboard", async () => {
    const elsewhere = fakeGateway({
      holder: "human",
      focus: {
        window: "browser",
        element: null,
        url: "https://shop.example/checkout",
      },
    });
    const outcome = await run(
      elsewhere.gateway,
      { kind: "type", text: "pizza", label: "it" },
      { seen: { url: "https://shop.example/cart" }, risk: "confirm" },
    );
    expect(outcome).toEqual({
      ok: false,
      detail: expect.stringContaining("changed"),
    });
    expect(elsewhere.inputs).toEqual([]);
  });

  test("a different element by its ref is a change, even with the same name", async () => {
    const fake = fakeGateway({ at: { ref: "e9" } });
    const outcome = await run(fake.gateway, clickContinue, {
      seen: {
        url: "https://shop.example/cart",
        role: "button",
        name: "Continue",
        ref: "e1",
      },
    });
    expect(outcome.ok ? "" : outcome.detail).toContain("changed");
    expect(fake.inputs).toEqual([]);
  });

  test("a page covered by another window at action time is asked about again, not called changed", async () => {
    const covered = fakeGateway({
      at: {
        role: "desktop",
        name: "",
        inPage: false,
        window: "other",
      },
    });
    const outcome = await run(covered.gateway, clickContinue, {
      seen: {
        url: "https://shop.example/cart",
        role: "button",
        name: "Continue",
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.detail).toBe(
      "What is there now needs a fresh yes.",
    );
    expect(covered.inputs).toEqual([]);
  });

  test("on the session's yes, any everyday element, rated again on what is there now", async () => {
    // Not the step's own element: the yes was for the session's everyday actions, not one element.
    const elsewhere = fakeGateway({ at: { ref: "e7" } });
    const outcome = await run(elsewhere.gateway, clickContinue, {
      viaGrant: true,
    });
    expect(outcome).toMatchObject({
      ok: true,
      audit: { viaGrant: true, scope: "session" },
    });
    expect(elsewhere.inputs).toHaveLength(1);
    // What is there now is no longer everyday: not done on the session's yes.
    const riskier = fakeGateway({ at: { name: "Submit order now" } });
    expect(
      (await run(riskier.gateway, clickContinue, { viaGrant: true })).ok,
    ).toBe(false);
    expect(riskier.inputs).toEqual([]);
    // A page that changed, or a deny rule, refuses it as for any yes.
    const moved = fakeGateway({ at: { url: "https://shop.example/pay" } });
    expect(
      (
        await run(moved.gateway, clickContinue, {
          viaGrant: true,
          seen: { url: "https://shop.example/cart" },
        })
      ).ok,
    ).toBe(false);
    const denied = fakeGateway({
      policy: {
        mode: "enforce",
        deny: ['contains(element.name, "Continue")'],
        allow: [],
      },
    });
    expect(
      (await run(denied.gateway, clickContinue, { viaGrant: true })).ok,
    ).toBe(false);
    expect(denied.inputs).toEqual([]);
  });

  test("another window over the page makes a yes for the page no yes at all", async () => {
    const covered = fakeGateway({ at: { window: "other" } });
    const outcome = await run(covered.gateway, clickContinue);
    expect(outcome.ok).toBe(false);
    expect(covered.inputs).toEqual([]);
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
    expect(fake.inputs).toEqual([]);
    expect(audits.map((row) => row.eventType)).toEqual([
      "clicky.action_blocked",
    ]);
    expect(JSON.stringify(audits)).not.toContain("hunter2");
  });

  test("refuses when what is there now is riskier than what the person said yes to", async () => {
    const fake = fakeGateway({ at: { name: "Submit order now" } });
    const outcome = await run(fake.gateway, clickContinue, { risk: "low" });
    expect(outcome.ok).toBe(false);
    expect(fake.inputs).toEqual([]);
    // Said yes to a confirm: a confirm still runs.
    const confirmed = fakeGateway({ at: { name: "Send" } });
    expect(
      (await run(confirmed.gateway, clickContinue, { risk: "confirm" })).ok,
    ).toBe(true);
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
    expect((await run(allowNothing.gateway, clickContinue)).ok).toBe(true);
    const dryRun = fakeGateway({
      policy: { mode: "dry-run", deny: [deny], allow: [] },
    });
    expect((await run(dryRun.gateway, clickContinue)).ok).toBe(true);
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

  test("keys go to what has the keyboard, and the trail says which keys and how much was typed", async () => {
    const fake = fakeGateway({ holder: "human" });
    const keyed = await run(fake.gateway, {
      kind: "key",
      keys: "Tab",
      label: "Tab",
    });
    expect(keyed).toMatchObject({ ok: true, audit: { keys: "Tab" } });
    const typed = await run(fake.gateway, {
      kind: "type",
      text: "pizza",
      label: "Search",
    });
    expect(typed).toMatchObject({ ok: true, audit: { characters: 5 } });
    expect(JSON.stringify(typed)).not.toContain("pizza");
    await run(fake.gateway, {
      kind: "scroll",
      at: { x: 0.5, y: 0.5 },
      deltaY: 400,
      label: "down",
    });
    // The page's keys and typing through the page's keyboard; the wheel through the desktop's.
    expect(fake.inputs).toEqual([
      { kind: "key", key: "Tab", keyboard: "page" },
      { kind: "type", text: "pizza", keyboard: "page" },
      {
        kind: "scroll",
        deltaY: 400,
        x: 720,
        y: 450,
        space: "screen",
        requireBrowser: true,
      },
    ]);
  });

  test("typing at a field clicks it through the desktop, then types through the page and presses Enter there", async () => {
    const fake = fakeGateway({
      holder: "human",
      at: { role: "searchbox", name: "Search", ref: "e3" },
    });
    const outcome = await run(fake.gateway, {
      kind: "type",
      text: "υπεύθυνη δήλωση",
      at: { x: 0.5, y: 0.5 },
      ref: "e3",
      label: "Search",
      pressEnter: true,
    });
    expect(outcome).toMatchObject({
      ok: true,
      audit: { characters: 15, keys: "Enter" },
    });
    expect(JSON.stringify(outcome)).not.toContain("δήλωση");
    expect(fake.calls).toContain("elementAt:verify");
    expect(fake.inputs).toEqual([
      { kind: "click", x: 720, y: 450, space: "screen", requireBrowser: true },
      {
        kind: "type",
        text: "υπεύθυνη δήλωση",
        keyboard: "page",
        at: { x: 720, y: 450 },
      },
      { kind: "key", key: "Enter", keyboard: "page", at: { x: 720, y: 450 } },
    ]);
  });

  test("the browser's own keys stay on the desktop's keyboard; a scroll to a step goes by its ref", async () => {
    const fake = fakeGateway({ holder: "human" });
    await run(
      fake.gateway,
      { kind: "key", keys: "Control+l", label: "address bar" },
      { risk: "confirm" },
    );
    await run(fake.gateway, {
      kind: "scroll",
      at: { x: 0.5, y: 0.5 },
      deltaY: 600,
      ref: "e40",
      label: "Bottom",
    });
    expect(fake.inputs).toEqual([
      { kind: "key", key: "Control+l", space: "screen", requireBrowser: true },
      { kind: "scroll-into-view", ref: "e40" },
    ]);
  });

  test("typing approved off the page knowingly stays on the desktop's keyboard", async () => {
    const fake = fakeGateway({
      holder: "human",
      at: { role: "desktop", name: "", inPage: false, window: "other" },
    });
    const outcome = await run(
      fake.gateway,
      { kind: "type", text: "notes", at: { x: 0.5, y: 0.02 }, label: "bar" },
      { risk: "confirm" },
    );
    expect(outcome.ok).toBe(true);
    expect(fake.inputs).toEqual([
      { kind: "click", x: 720, y: 18, space: "screen" },
      { kind: "type", text: "notes", space: "screen" },
    ]);
  });

  test("a key with nothing on the page holding the keyboard is not pressed on a low-risk yes", async () => {
    const fake = fakeGateway({
      holder: "human",
      focus: { window: "other", element: null, url: "" },
    });
    const outcome = await run(fake.gateway, {
      kind: "key",
      keys: "Tab",
      label: "Tab",
    });
    expect(outcome.ok).toBe(false);
    expect(fake.inputs).toEqual([]);
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
