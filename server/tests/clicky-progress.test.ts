import { describe, expect, test } from "bun:test";
import type { ClickySession } from "../../shared/clicky";
import type { BrainCheck, ClickyBrain } from "../src/clicky/brain";
import { createClickyHub } from "../src/clicky/hub";
import { viewerScrolled, viewerTyping } from "../src/clicky/index";
import { createClickyPresence } from "../src/clicky/presence";
import {
  botVerbOf,
  type ClickyPreferences,
  createClickyService,
} from "../src/clicky/service";
import { createInMemoryClickyStore } from "../src/clicky/store";
import type {
  ElementRect,
  PageState,
  ScreenElements,
} from "../src/computer/schema";

/*
 * Show me how follows the person's progress: after they type, press Enter or click (and after it
 * acts for them), it watches whether the page moved on and looks again, without leaving the step;
 * the look's answer moves the walkthrough on and puts the pointer where the control is now. And
 * while the person watches the Bot work, it narrates each action, asking only where that one
 * element is.
 */

const screen: ScreenElements = {
  screen: { width: 1000, height: 500 },
  mode: "page",
  url: "https://search.example/",
  elements: [
    {
      ref: "e1",
      role: "searchbox",
      name: "Search",
      rect: { x: 100, y: 100, width: 300, height: 40 },
      sensitive: false,
      focused: false,
    },
  ],
};

const preferences = async (): Promise<ClickyPreferences> => ({
  locale: "en",
  guidance: "brief",
  actionPolicy: "ask_each",
  autoActivate: true,
});

/** The page the watch reads: navigations are counted by hand. */
function fakePage() {
  const state: PageState = {
    url: "https://search.example/",
    title: "Search",
    navigationId: 0,
    settled: true,
  };
  const reads: number[] = [];
  return {
    state,
    reads,
    pageState: async () => {
      reads.push(Date.now());
      return { ...state };
    },
    navigate(url: string) {
      state.url = url;
      state.navigationId += 1;
    },
  };
}

function harness(
  options: {
    check?: (
      input: Parameters<NonNullable<ClickyBrain["check"]>>[0],
    ) => Promise<BrainCheck> | BrainCheck;
    checks?: { burst?: number; perMinute?: number };
    elementRect?: (
      botId: string,
      ref: string,
      snapshotId?: number,
    ) => Promise<ElementRect>;
    released?: string[];
    think?: ClickyBrain["think"];
  } = {},
) {
  const store = createInMemoryClickyStore();
  const hub = createClickyHub({ load: (u, b) => store.load(u, b) });
  const page = fakePage();
  const looks: { stepId: string | null; signal: AbortSignal }[] = [];
  const elementsCalls: string[] = [];
  const brain: ClickyBrain = {
    async think(input) {
      if (options.think) return options.think(input);
      return {
        type: "brain.reply",
        thinkId: input.thinkId,
        say: "Two steps.",
        plan: {
          goal: "Search",
          steps: [
            {
              title: "Type in the search box",
              overlays: [
                {
                  kind: "pointer",
                  id: "p-old",
                  at: { x: 0.25, y: 0.24 },
                },
              ],
              targetRef: "e1",
            },
            { title: "Open the first result", overlays: [] },
          ],
        },
      };
    },
    async check(input) {
      looks.push({ stepId: input.stepId, signal: input.signal });
      return options.check
        ? options.check(input)
        : {
            stepDone: true,
            overlays: [
              { kind: "pointer", id: "p-new", at: { x: 0.5, y: 0.6 } },
            ],
          };
    },
  };
  const service = createClickyService({
    store,
    hub,
    preferences,
    brain,
    gateway: {
      elements: async () => {
        elementsCalls.push("elements");
        return screen;
      },
      writeFile: async () => ({ path: "", bytes: 0, appended: false }),
      pageState: page.pageState,
      ...(options.elementRect ? { elementRect: options.elementRect } : {}),
    },
    progress: {
      pollMs: 20,
      windowMs: 200,
      extendMs: 100,
      typingSettleMs: 40,
      scrollSettleMs: 40,
      loadingRetryMs: 10,
      settleFloorMs: 5,
    },
    ...(options.checks ? { checks: options.checks } : {}),
    ...(options.released
      ? {
          releaseOwnControl: async (userId: string, botId: string) => {
            options.released?.push(`${userId}/${botId}`);
          },
        }
      : {}),
  });
  const load = async () =>
    (await store.load("user-1", "bot-1")) as ClickySession;
  /** A walkthrough on the screen, the first step current. */
  const guiding = async () => {
    await service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "ask", text: "How do I search?" },
    });
    await until(async () => (await load())?.state === "guiding");
  };
  return { store, service, page, looks, elementsCalls, load, guiding };
}

async function until(check: () => boolean | Promise<boolean>, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await Bun.sleep(5);
  }
}

describe("after the person types", () => {
  test("Enter with no navigation: once typing has settled, it looks, finishes the step and points anew", async () => {
    const { service, looks, load, guiding } = harness();
    await guiding();
    const step = (await load()).walkthrough?.currentStepId;
    service.personTyped("user-1", "bot-1", "submit");
    await until(() => looks.length === 1);
    expect(looks[0]?.stepId).toBe(step ?? null);
    await until(async () => (await load()).check === null);
    const session = await load();
    expect(session.state).toBe("guiding");
    expect(session.overlaysStale).toBe(false);
    expect(session.walkthrough?.steps.map((s) => s.status)).toEqual([
      "done",
      "current",
    ]);
    expect(session.walkthrough?.steps[1]?.overlays).toEqual([
      { kind: "pointer", id: "p-new", at: { x: 0.5, y: 0.6 } },
    ]);
  });

  test("plain typing is looked at once, after it pauses: a field typed into and left is a step done", async () => {
    const { service, looks, guiding } = harness();
    await guiding();
    // Keys closer together than the pause are one burst, and one look.
    for (let key = 0; key < 5; key += 1) {
      service.personTyped("user-1", "bot-1", "text");
      await Bun.sleep(10);
    }
    expect(looks).toHaveLength(0);
    await until(() => looks.length === 1);
    await Bun.sleep(150);
    expect(looks).toHaveLength(1);
  });

  test("the person's scroll is looked at once the wheel stops: 'scroll down' done, the control placed", async () => {
    const { service, looks, load, guiding } = harness();
    await guiding();
    const step = (await load()).walkthrough?.currentStepId;
    for (let turn = 0; turn < 4; turn += 1) {
      service.personScrolled("user-1", "bot-1");
      await Bun.sleep(10);
    }
    await until(() => looks.length === 1);
    expect(looks[0]?.stepId).toBe(step ?? null);
    await Bun.sleep(150);
    expect(looks).toHaveLength(1);
  });

  test("Enter that opens a page: the navigation is what is looked at, once", async () => {
    const { service, looks, page, load, guiding } = harness();
    await guiding();
    // The page is still on its way: the look waits for it rather than looking at the old page.
    page.state.settled = false;
    service.personTyped("user-1", "bot-1", "submit");
    await until(() => page.reads.length >= 1);
    page.navigate("https://search.example/results?q=declaration");
    await Bun.sleep(30);
    expect(looks).toHaveLength(0);
    page.state.settled = true;
    await until(() => looks.length >= 1);
    await until(async () => (await load()).check === null);
    await Bun.sleep(100);
    expect(looks).toHaveLength(1);
    expect((await load()).walkthrough?.steps[0]?.status).toBe("done");
  });

  test("nothing is watched while Clicky is not guiding", async () => {
    const { service, looks, page } = harness();
    service.personTyped("user-1", "bot-1", "submit");
    service.personInput(
      "user-1",
      "bot-1",
      { x: 0.1, y: 0.1 },
      { driving: true },
    );
    await Bun.sleep(80);
    expect(looks).toEqual([]);
    expect(page.reads).toEqual([]);
  });
});

describe("after the person clicks", () => {
  test("a click that opens a page elsewhere is looked at, without the step being clicked", async () => {
    const { service, looks, page, load, guiding } = harness({
      check: () => ({ stepDone: false }),
    });
    await guiding();
    // Not on the step's target: the step stays, and the page it opened is still looked at.
    service.personInput(
      "user-1",
      "bot-1",
      { x: 0.9, y: 0.9 },
      { driving: true },
    );
    await until(() => page.reads.length >= 1);
    expect(looks).toHaveLength(0);
    page.navigate("https://search.example/elsewhere");
    await until(() => looks.length === 1);
    await until(async () => (await load()).check === null);
    expect((await load()).walkthrough?.steps[0]?.status).toBe("current");
  });

  test("a click by somebody not driving the computer is never watched", async () => {
    const { service, page, guiding } = harness();
    await guiding();
    const before = page.reads.length;
    service.personInput(
      "user-1",
      "bot-1",
      { x: 0.9, y: 0.9 },
      { driving: false },
    );
    await Bun.sleep(60);
    expect(page.reads.length).toBe(before);
  });
});

describe("the look after a step", () => {
  test("a look asked for again about the same step is the one already running, answered under the new id", async () => {
    let release: (() => void) | undefined;
    const { service, looks, load, guiding } = harness({
      check: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          stepDone: true,
          overlays: [{ kind: "pointer", id: "p-2", at: { x: 0.2, y: 0.2 } }],
        };
      },
    });
    await guiding();
    service.personTyped("user-1", "bot-1", "submit");
    await until(() => looks.length === 1);
    const first = (await load()).check?.id;
    // Enter again while the look is out: the reducer asks again, the same look answers.
    service.personTyped("user-1", "bot-1", "submit");
    await until(async () => (await load()).check?.id !== first);
    await Bun.sleep(40);
    expect(looks).toHaveLength(1);
    expect(looks[0]?.signal.aborted).toBe(false);
    release?.();
    await until(async () => (await load()).check === null);
    const session = await load();
    expect(session.walkthrough?.steps.map((step) => step.status)).toEqual([
      "done",
      "current",
    ]);
    expect(session.walkthrough?.steps[1]?.overlays).toEqual([
      { kind: "pointer", id: "p-2", at: { x: 0.2, y: 0.2 } },
    ]);
  });

  test("a page that moved on since the running look looked is looked at afresh; Stop aborts the one running", async () => {
    let call = 0;
    const { service, looks, page, load, guiding } = harness({
      check: () => {
        call += 1;
        // The first look never answers: it is looking at the page before the navigation.
        return call === 1
          ? new Promise<BrainCheck>(() => {})
          : { stepDone: false };
      },
    });
    await guiding();
    service.personTyped("user-1", "bot-1", "submit");
    await until(() => looks.length === 1);
    // A click that reached the computer, and the page it opened.
    const reads = page.reads.length;
    service.personInput(
      "user-1",
      "bot-1",
      { x: 0.9, y: 0.9 },
      { driving: true },
    );
    await until(() => page.reads.length > reads);
    page.navigate("https://search.example/results");
    await until(() => looks.length === 2);
    expect(looks[0]?.signal.aborted).toBe(true);
    await until(async () => (await load()).check === null);

    // Stop while a look is running aborts it.
    let stopped: AbortSignal | undefined;
    const second = harness({
      check: (input) => {
        stopped = input.signal;
        return new Promise(() => {});
      },
    });
    await second.guiding();
    second.service.personTyped("user-1", "bot-1", "submit");
    await until(() => stopped !== undefined);
    await second.service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "stop" },
    });
    expect(stopped?.aborted).toBe(true);
    expect((await second.load()).check).toBeNull();
  });

  test("past its own limit a look is not taken, and says so: the marks stay dimmed, not shown as current", async () => {
    const { service, looks, load, guiding } = harness({
      checks: { burst: 1, perMinute: 0.001 },
      check: () => ({ stepDone: false }),
    });
    await guiding();
    service.personTyped("user-1", "bot-1", "submit");
    await until(() => looks.length === 1);
    await until(async () => (await load()).check === null);
    const before = await load();
    expect(before.overlaysStale).toBe(false);
    service.personTyped("user-1", "bot-1", "submit");
    await until(async () => (await load()).seq > before.seq + 1);
    await until(async () => (await load()).check === null);
    expect(looks).toHaveLength(1);
    expect((await load()).overlaysStale).toBe(true);
  });

  test("a look whose model call fails says so too", async () => {
    const { service, load, guiding } = harness({
      check: () => {
        throw new Error("model down");
      },
    });
    await guiding();
    const marks = (await load()).walkthrough?.steps[0]?.overlays;
    service.personTyped("user-1", "bot-1", "submit");
    await until(async () => (await load()).overlaysStale === true);
    await until(async () => (await load()).check === null);
    const session = await load();
    expect(session.overlaysStale).toBe(true);
    expect(session.walkthrough?.steps[0]?.overlays).toEqual(marks ?? []);
  });
});

describe("narration", () => {
  test("a person watching the Bot sees each action pointed at, by where the Bot's own element is", async () => {
    const asked: { ref: string; snapshotId?: number }[] = [];
    const { service, load, elementsCalls } = harness({
      elementRect: async (_botId, ref, snapshotId) => {
        asked.push({
          ref,
          ...(snapshotId !== undefined ? { snapshotId } : {}),
        });
        return {
          screen: { width: 1000, height: 500 },
          rect: { x: 100, y: 100, width: 200, height: 50 },
        };
      },
    });
    await service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "watch" },
    });
    service.botAction("user-1", "bot-1", {
      tool: "computer_click",
      ref: "e7",
      snapshotId: 4,
      role: "button",
      name: "Αναζήτηση",
      url: "https://gov.example/",
    });
    await until(async () => (await load()).reply?.notice === "narrate_click");
    const session = await load();
    expect(asked).toEqual([{ ref: "e7", snapshotId: 4 }]);
    expect(session.reply?.params).toEqual({ label: "Αναζήτηση" });
    expect(session.overlays.find((o) => o.kind === "highlight")).toMatchObject({
      rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
    });
    // Narrating never takes a look of its own: that would replace the Bot's refs.
    expect(elementsCalls).toEqual([]);

    service.botAction("user-1", "bot-1", {
      tool: "computer_navigate",
      url: "https://www.gov.gr/ipiresies",
    });
    await until(
      async () => (await load()).reply?.notice === "narrate_navigate",
    );
    expect((await load()).reply?.params).toEqual({ host: "www.gov.gr" });
  });

  test("nobody watching, nothing asked: not the session, and not the element's place", async () => {
    const asked: string[] = [];
    const { service, store, load, guiding } = harness({
      elementRect: async (_botId, ref) => {
        asked.push(ref);
        return { rect: null };
      },
    });
    const loads: string[] = [];
    const load0 = store.load.bind(store);
    store.load = async (userId, botId) => {
      loads.push(`${userId}/${botId}`);
      return load0(userId, botId);
    };
    service.botAction("user-1", "bot-1", { tool: "computer_click", ref: "e1" });
    service.botAction("user-2", "bot-1", { tool: "computer_click", ref: "e1" });
    await Bun.sleep(20);
    expect(loads).toEqual([]);
    await guiding();
    const before = await load();
    service.botAction("user-1", "bot-1", { tool: "computer_click", ref: "e1" });
    await Bun.sleep(40);
    expect(asked).toEqual([]);
    expect((await load()).seq).toBe(before.seq);
  });

  test("a burst of actions shows the latest, not a backlog", async () => {
    let release: (() => void) | undefined;
    const asked: string[] = [];
    const { service, load } = harness({
      elementRect: async (_botId, ref) => {
        asked.push(ref);
        if (asked.length === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { rect: null };
      },
    });
    await service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "watch" },
    });
    for (const ref of ["e1", "e2", "e3", "e4"])
      service.botAction("user-1", "bot-1", {
        tool: "computer_type",
        ref,
        name: `Field ${ref}`,
      });
    await until(() => release !== undefined);
    release?.();
    await until(async () => (await load()).reply?.params?.label === "Field e4");
    expect(asked).toEqual(["e1", "e4"]);
  });

  test("with the Bot's screen open, narration starts by itself on an asleep session", async () => {
    const asked: string[] = [];
    const { service, load } = harness({
      elementRect: async (_botId, ref) => {
        asked.push(ref);
        return {
          screen: { width: 1000, height: 500 },
          rect: { x: 100, y: 100, width: 200, height: 50 },
        };
      },
    });
    // Nobody has opened anything: no session at all yet.
    service.botAction(
      "user-1",
      "bot-1",
      { tool: "computer_click", ref: "e7", name: "Login" },
      { autoWatch: true },
    );
    await until(async () => (await load())?.reply?.notice === "narrate_click");
    const session = await load();
    expect(session).toMatchObject({
      awake: true,
      narrating: true,
      trigger: { kind: "person" },
    });
    expect(asked).toEqual(["e7"]);
  });

  test("never over a walkthrough, a Stop or the Bot needing the person", async () => {
    const guided = harness({
      elementRect: async () => ({ rect: null }),
    });
    await guided.guiding();
    const before = await guided.load();
    guided.service.botAction(
      "user-1",
      "bot-1",
      { tool: "computer_click", ref: "e1", name: "Search" },
      { autoWatch: true },
    );
    await Bun.sleep(40);
    expect((await guided.load()).seq).toBe(before.seq);
    expect((await guided.load()).narrating).toBe(false);

    const stopped = harness({ elementRect: async () => ({ rect: null }) });
    await stopped.service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "stop" },
    });
    const halted = await stopped.load();
    stopped.service.botAction(
      "user-1",
      "bot-1",
      { tool: "computer_click", ref: "e1", name: "Search" },
      { autoWatch: true },
    );
    await Bun.sleep(40);
    expect((await stopped.load()).seq).toBe(halted.seq);

    const needed = harness({ elementRect: async () => ({ rect: null }) });
    await needed.service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "overlay.clear" },
    });
    await needed.store.save(
      "user-1",
      "bot-1",
      {
        ...(await needed.load()),
        awake: true,
        state: "idle",
        trigger: { kind: "sign_in", requestId: "s1" },
      },
      (await needed.load()).seq,
    );
    needed.service.botAction(
      "user-1",
      "bot-1",
      { tool: "computer_click", ref: "e1", name: "Search" },
      { autoWatch: true },
    );
    await Bun.sleep(40);
    expect((await needed.load()).narrating).toBe(false);
  });

  test("the Bot's tools as narration names them", () => {
    expect(
      [
        "computer_click",
        "computer_type",
        "computer_fill",
        "computer_navigate",
        "computer_back",
        "computer_scroll",
        "computer_select",
        "computer_check",
        "computer_key",
        "computer_hover",
      ].map(botVerbOf),
    ).toEqual([
      "click",
      "type",
      "type",
      "navigate",
      "navigate",
      "scroll",
      "select",
      "click",
      "key",
      "other",
    ]);
  });
});

describe("handing the computer back", () => {
  test("Stop hands back a computer the person holds only for Clicky; sleep leaves it to the app", async () => {
    const released: string[] = [];
    const { service } = harness({ released });
    for (const type of ["wake", "sleep", "wake", "sleep"] as const)
      await service.dispatch("user-1", "bot-1", {
        type: "command",
        command: { type },
      });
    await Bun.sleep(30);
    // The app releases on sleep itself, unless the person chose to keep control.
    expect(released).toEqual([]);
    await service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "stop" },
    });
    await until(() => released.length === 1);
    expect(released).toEqual(["user-1/bot-1"]);
  });
});

describe("what the viewer's keys say", () => {
  test("Enter and Tab are a submit, other typing is text, and nothing else counts", () => {
    const key = (key: string, event = "down") =>
      JSON.stringify({ type: "key", event, key, code: "KeyA", modifiers: 0 });
    expect(viewerTyping(key("Enter"))).toBe("submit");
    expect(viewerTyping(key("Tab"))).toBe("submit");
    expect(viewerTyping(key("a"))).toBe("text");
    expect(viewerTyping(key("ά"))).toBe("text");
    expect(viewerTyping(key("Backspace"))).toBe("text");
    expect(viewerTyping(key("Enter", "up"))).toBeNull();
    expect(viewerTyping(key("Shift"))).toBeNull();
    expect(viewerTyping(key("ArrowDown"))).toBeNull();
    expect(viewerTyping(JSON.stringify({ type: "text", text: "paste" }))).toBe(
      "text",
    );
    expect(
      viewerTyping(
        JSON.stringify({ type: "mouse", event: "moved", x: 1, y: 2 }),
      ),
    ).toBeNull();
    expect(viewerTyping('not json with a "key"')).toBeNull();
  });

  test("a turn of the wheel is a scroll; a wheel that did not move, or anything else, is not", () => {
    const wheel = (deltaY: number, deltaX = 0) =>
      JSON.stringify({
        type: "wheel",
        x: 1,
        y: 2,
        deltaX,
        deltaY,
        modifiers: 0,
      });
    expect(viewerScrolled(wheel(120))).toBe(true);
    expect(viewerScrolled(wheel(0, -40))).toBe(true);
    expect(viewerScrolled(wheel(0))).toBe(false);
    expect(viewerScrolled(JSON.stringify({ type: "key", key: "wheel" }))).toBe(
      false,
    );
    expect(viewerScrolled('not json "wheel"')).toBe(false);
  });
});

describe("who is watching, and whether the Bot is at work", () => {
  test("a screen open twice is still open after one closes; closed, it is not", () => {
    const presence = createClickyPresence();
    presence.viewerOpen("user-1", "bot-1", true);
    presence.viewerOpen("user-1", "bot-1", true);
    presence.viewerOpen("user-1", "bot-1", false);
    expect(presence.viewing("user-1", "bot-1")).toBe(true);
    expect(presence.viewing("user-2", "bot-1")).toBe(false);
    presence.viewerOpen("user-1", "bot-1", false);
    expect(presence.viewing("user-1", "bot-1")).toBe(false);
    // A close never heard opened does not go below nothing.
    presence.viewerOpen("user-1", "bot-1", false);
    presence.viewerOpen("user-1", "bot-1", true);
    expect(presence.viewing("user-1", "bot-1")).toBe(true);
  });

  test("at work while a run holds its lock for that person, or for a few seconds after it acted", () => {
    let now = 1_000;
    const presence = createClickyPresence({ now: () => now });
    expect(presence.botActive("user-1", "bot-1")).toBe(false);
    presence.runBusy({
      threadId: "t1",
      busy: true,
      userId: "user-1",
      agentId: "bot-1",
    });
    expect(presence.botActive("user-1", "bot-1")).toBe(true);
    expect(presence.botActive("user-2", "bot-1")).toBe(false);
    presence.runBusy({ threadId: "t1", busy: false });
    expect(presence.botActive("user-1", "bot-1")).toBe(false);
    presence.botActed("user-1", "bot-1");
    now += 14_000;
    expect(presence.botActive("user-1", "bot-1")).toBe(true);
    now += 2_000;
    expect(presence.botActive("user-1", "bot-1")).toBe(false);
  });
});

describe("a look at a page still loading", () => {
  test("is made again once the page settles, and only its answer is shown", async () => {
    // Live, on dilosi.services.gov.gr: "Wait for page load", a step nobody could do.
    let asked = 0;
    const { service, load } = harness({
      think: async (input) => {
        asked += 1;
        return asked < 3
          ? {
              type: "brain.reply",
              thinkId: input.thinkId,
              say: "The page is still loading.",
              loading: true,
            }
          : {
              type: "brain.reply",
              thinkId: input.thinkId,
              say: "Press Continue.",
              plan: {
                goal: "Issue a declaration",
                steps: [{ title: "Press Continue", overlays: [] }],
              },
            };
      },
    });
    await service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "ask", text: "Θέλω να εκδώσω υπεύθυνη δήλωση" },
    });
    await until(async () => (await load())?.state === "guiding");
    expect(asked).toBe(3);
    const session = await load();
    expect(session.reply?.text).toBe("Press Continue.");
    expect(session.walkthrough?.steps[0]?.title).toBe("Press Continue");
  });

  test("gives up looking again after a few tries, and says what it saw", async () => {
    let asked = 0;
    const { service, load } = harness({
      think: async (input) => {
        asked += 1;
        return {
          type: "brain.reply",
          thinkId: input.thinkId,
          say: "The page is still loading.",
          loading: true,
        };
      },
    });
    await service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "ask", text: "what now?" },
    });
    await until(async () => (await load())?.state !== "thinking");
    expect(asked).toBe(4);
    expect((await load()).reply?.text).toBe("The page is still loading.");
  });
});
