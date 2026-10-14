import { describe, expect, test } from "bun:test";
import type { ComputerControlState } from "../../shared/computer-control";
import { CLICKY_HELP_REASON } from "../src/clicky/actions";
import { createClickyActivation } from "../src/clicky/activation";
import { needsYouText } from "../src/clicky/index";
import { createSocketSessions } from "../src/clicky/socket-sessions";
import type { ClickyBrain } from "../src/clicky/brain";
import { createClickyHub } from "../src/clicky/hub";
import {
  type ClickyPreferences,
  createClickyService,
} from "../src/clicky/service";
import { createInMemoryClickyStore } from "../src/clicky/store";
import type { ComputerControlEvent } from "../src/computer/gateway";
import type { ScreenElements } from "../src/computer/schema";

/*
 * Clicky opens by itself when the Bot needs the person on its computer, once per request, and closes
 * the request when the handover ends. A person who switched that off is left alone, and so is
 * Clicky's own request for control.
 */

const screen: ScreenElements = {
  screen: { width: 1000, height: 1000 },
  mode: "desktop",
  url: "https://bank.example/",
  elements: [
    {
      ref: "e7",
      role: "button",
      name: "I'm not a robot",
      rect: { x: 400, y: 400, width: 200, height: 100 },
      sensitive: false,
      focused: false,
    },
  ],
};

function harness(autoActivate = true, canUse = true) {
  const store = createInMemoryClickyStore();
  const hub = createClickyHub({ load: (u, b) => store.load(u, b) });
  const looks: { reason: string; trigger: unknown }[] = [];
  // The model never answers: these tests are about what opens Clicky, not what it says.
  const brain: ClickyBrain = {
    think: (input) => {
      looks.push({ reason: input.reason, trigger: input.session.trigger });
      return new Promise(() => {});
    },
  };
  const preferences = async (): Promise<ClickyPreferences> => ({
    locale: "en",
    guidance: "brief",
    actionPolicy: "ask_each",
    autoActivate,
  });
  const service = createClickyService({
    store,
    hub,
    preferences,
    brain,
    gateway: {
      elements: async () => screen,
      writeFile: async () => ({ path: "", bytes: 0, appended: false }),
    },
  });
  const pushed: unknown[] = [];
  const activation = createClickyActivation({
    service,
    needsYou: async (input) => {
      pushed.push(input);
    },
    canUseComputer: async () => canUse,
  });
  return { store, activation, looks, pushed, service };
}

const waiting = (
  id: string,
  source: "model" | "cloudflare" = "model",
): ComputerControlState => ({
  holder: "bot",
  since: "2026-10-14T00:00:00.000Z",
  requested: true,
  reason: "Please sign in",
  request: {
    id,
    reason: "Please sign in",
    source,
    status: "waiting",
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  },
  transitioning: false,
  resumeSnapshotRequired: false,
});

const helpRequested = (
  overrides: Partial<ComputerControlEvent> = {},
): ComputerControlEvent => ({
  type: "help_requested",
  botId: "bot-1",
  userId: "user-1",
  reason: "Please sign in to your bank",
  state: waiting("r1"),
  ...overrides,
});

async function until(check: () => boolean | Promise<boolean>, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await Bun.sleep(5);
  }
}

describe("from the gateway's handover events", () => {
  test("a help request opens Clicky with its trigger, looking at the screen", async () => {
    const { store, activation, looks, pushed } = harness();
    activation.onControlEvent(helpRequested());
    await until(async () => Boolean(await store.load("user-1", "bot-1")));
    await until(() => looks.length === 1);
    const session = await store.load("user-1", "bot-1");
    expect(session).toMatchObject({
      awake: true,
      state: "thinking",
      trigger: {
        kind: "takeover",
        requestId: "r1",
        reason: "Please sign in to your bank",
      },
      reply: { notice: "takeover", text: "Please sign in to your bank" },
    });
    expect(looks[0]?.reason).toBe("activate");
    await until(() => pushed.length === 1);
    expect(pushed[0]).toMatchObject({
      userId: "user-1",
      botId: "bot-1",
      trigger: { kind: "takeover", requestId: "r1" },
    });
  });

  test("the same request again changes nothing and is not pushed again", async () => {
    const { store, activation, pushed } = harness();
    activation.onControlEvent(helpRequested());
    await until(() => pushed.length === 1);
    const before = await store.load("user-1", "bot-1");
    activation.onControlEvent(helpRequested());
    await Bun.sleep(30);
    expect((await store.load("user-1", "bot-1"))?.seq).toBe(before?.seq);
    expect(pushed).toHaveLength(1);
  });

  test("handing control back resolves it", async () => {
    const { store, activation } = harness();
    activation.onControlEvent(helpRequested());
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.trigger !== null &&
        (await store.load("user-1", "bot-1")) !== null,
    );
    activation.onControlEvent({
      type: "control_released",
      botId: "bot-1",
      userId: "user-1",
      state: { ...waiting("r1"), holder: "bot", requested: false },
    });
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.reply?.notice ===
        "takeover_resolved",
    );
    const session = await store.load("user-1", "bot-1");
    expect(session?.trigger).toBeNull();
    expect(session?.thinkId).toBeNull();
  });

  test("a cancelled request closes without thanks", async () => {
    const { store, activation } = harness();
    activation.onControlEvent(helpRequested());
    await until(async () => Boolean(await store.load("user-1", "bot-1")));
    activation.onControlEvent({
      type: "help_cancelled",
      botId: "bot-1",
      userId: "user-1",
      state: waiting("r1"),
    });
    await until(
      async () => (await store.load("user-1", "bot-1"))?.trigger === null,
    );
  });

  test("a page's challenge is a challenge, and point_at points before the model has looked", async () => {
    const { store, activation } = harness();
    activation.onControlEvent(
      helpRequested({ state: waiting("r2", "cloudflare"), pointAt: "e7" }),
    );
    await until(async () =>
      Boolean(
        (await store.load("user-1", "bot-1"))?.overlays.some(
          (overlay) => overlay.kind === "pointer",
        ),
      ),
    );
    const session = await store.load("user-1", "bot-1");
    expect(session?.trigger).toMatchObject({
      kind: "challenge",
      requestId: "r2",
      targetRef: "e7",
    });
    expect(session?.state).toBe("thinking");
    const pointer = session?.overlays.find((o) => o.kind === "pointer");
    expect(pointer).toMatchObject({ at: { x: 0.5, y: 0.45 } });
    expect(session?.overlays.some((o) => o.kind === "caption")).toBe(true);
  });

  test("a secret request points at its field, and entering it resolves it", async () => {
    const { store, activation } = harness();
    activation.onControlEvent({
      type: "secret_requested",
      botId: "bot-1",
      userId: "user-1",
      reason: "your one-time code",
      state: {
        ...waiting("r9"),
        secretWanted: "your one-time code",
        secretRef: "e7",
        secretSnapshotId: 4,
      },
    });
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.trigger?.kind === "secret",
    );
    expect((await store.load("user-1", "bot-1"))?.trigger).toMatchObject({
      kind: "secret",
      requestId: "secret:e7:4",
      targetRef: "e7",
    });
    activation.onControlEvent({
      type: "secret_supplied",
      botId: "bot-1",
      userId: "user-1",
      state: waiting("r9"),
    });
    await until(
      async () => (await store.load("user-1", "bot-1"))?.trigger === null,
    );
  });

  test("nothing opens for a person who turned it off, for nobody, or for Clicky's own request", async () => {
    const off = harness(false);
    off.activation.onControlEvent(helpRequested());
    const nobody = harness();
    nobody.activation.onControlEvent(helpRequested({ userId: undefined }));
    const own = harness();
    own.activation.onControlEvent(
      helpRequested({ reason: CLICKY_HELP_REASON }),
    );
    await Bun.sleep(40);
    expect(await off.store.load("user-1", "bot-1")).toBeNull();
    expect(off.pushed).toEqual([]);
    expect(nobody.store.all()).toEqual([]);
    expect(await own.store.load("user-1", "bot-1")).toBeNull();
  });
});

describe("from a run waiting on the person", () => {
  test("a private sign-in opens Clicky as the person's to do", async () => {
    const { store, activation } = harness();
    activation.onWaiting({
      userId: "user-1",
      botId: "bot-1",
      wait: {
        threadId: "t1",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "computer_request_sign_in",
        waiting: {
          kind: "computer_sign_in",
          requestId: "s1",
          site: "https://bank.example",
        },
        message:
          "Waiting for the person to sign in to https://bank.example in a private form.",
      },
    });
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.trigger?.kind === "sign_in",
    );
    expect((await store.load("user-1", "bot-1"))?.trigger?.requestId).toBe(
      "s1",
    );
  });

  test("an approval opens Clicky only when the person must do it themselves", async () => {
    const plain = harness();
    plain.activation.onWaiting({
      userId: "user-1",
      botId: "bot-1",
      wait: {
        threadId: "t1",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "computer_click",
        waiting: { kind: "approval", requestId: "a1" },
        message: "This action is waiting for your approval.",
      },
    });
    const handOff = harness();
    handOff.activation.onWaiting({
      userId: "user-1",
      botId: "bot-1",
      wait: {
        threadId: "t1",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "computer_click",
        waiting: { kind: "approval", requestId: "a2", handoff: true },
        message:
          "This needs you: paying. Do it yourself, then mark it done in Approvals.",
      },
    });
    await until(
      async () =>
        (await handOff.store.load("user-1", "bot-1"))?.trigger?.kind ===
        "approval",
    );
    expect(await plain.store.load("user-1", "bot-1")).toBeNull();
  });
});

describe("when a run ends", () => {
  test("an awake Clicky says the Bot finished; a person not using it is left alone", async () => {
    const { store, activation, service } = harness();
    await service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "wake" },
    });
    activation.onRunBusy({
      threadId: "th-1",
      busy: true,
      userId: "user-1",
      agentId: "bot-1",
    });
    activation.onRunBusy({ threadId: "th-1", busy: false });
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.reply?.notice === "follow_up",
    );
    expect((await store.load("user-1", "bot-1"))?.trigger).toEqual({
      kind: "follow_up",
    });

    activation.onRunBusy({
      threadId: "th-2",
      busy: true,
      userId: "user-2",
      agentId: "bot-1",
    });
    activation.onRunBusy({ threadId: "th-2", busy: false });
    await Bun.sleep(30);
    expect(await store.load("user-2", "bot-1")).toBeNull();
  });
});

describe("the security round", () => {
  test("nothing opens, is pushed or looked at for a person who may not use that computer", async () => {
    const { store, activation, looks, pushed } = harness(true, false);
    activation.onControlEvent(helpRequested());
    activation.onWaiting({
      userId: "user-1",
      botId: "bot-1",
      wait: {
        threadId: "t1",
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "computer_request_sign_in",
        waiting: { kind: "computer_sign_in", requestId: "s1" },
        message: "Sign in",
      },
    });
    await Bun.sleep(40);
    expect(await store.load("user-1", "bot-1")).toBeNull();
    expect(looks).toEqual([]);
    expect(pushed).toEqual([]);
  });

  test("the phone's lock screen says what kind of help, never the Bot's words", () => {
    const takeover = needsYouText({ kind: "takeover" }, "en");
    expect(takeover).toEqual({
      title: "Noë Bot needs you",
      body: "Noë Bot needs your help on its computer.",
    });
    expect(needsYouText({ kind: "sign_in" }, "el")).toEqual({
      title: "Το Noë Bot σε χρειάζεται",
      body: "Το Noë Bot χρειάζεται να συνδεθείς.",
    });
    for (const kind of [
      "takeover",
      "sign_in",
      "secret",
      "challenge",
      "approval",
      "person",
      "follow_up",
    ] as const)
      expect(needsYouText({ kind }, "en").body).not.toContain("undefined");
  });
});

describe("sockets and their sessions", () => {
  test("a revoked phone's sockets close at once, and a sweep closes those whose session ended", async () => {
    const alive = new Set(["live", "revoked"]);
    const sessions = createSocketSessions({
      alive: async (tokens) => new Set(tokens.filter((t) => alive.has(t))),
    });
    const closed: string[] = [];
    sessions.watch("live", () => closed.push("live"));
    sessions.watch("revoked", () => closed.push("revoked"));
    sessions.watch("ended", () => closed.push("ended"));
    // A socket with no session to check (single-user mode) is never closed by this.
    sessions.watch(null, () => closed.push("none"));
    sessions.revoke("revoked");
    expect(closed).toEqual(["revoked"]);
    await sessions.sweep();
    expect(closed).toEqual(["revoked", "ended"]);
    expect(sessions.size()).toBe(1);
    const detach = sessions.watch("live", () => closed.push("again"));
    detach();
    alive.delete("live");
    await sessions.sweep();
    expect(closed).toEqual(["revoked", "ended", "live"]);
  });
});
