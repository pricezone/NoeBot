import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";
import { LiveScreen } from "@/components/computer/live-screen";
import { TooltipProvider } from "@/components/ui/tooltip";
import { mayWatch, selectGuidance } from "@/lib/clicky/viewer-control";
import type { ControlState } from "@/lib/computers/control";
import { computerSleep } from "@/lib/computers/use-computer-sleep";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import {
  CLICKY_HELP_REASON,
  type ClickyCommand,
  type ClickySession,
  newClickySession,
} from "../../shared/clicky";
import { settleReactWork } from "./settle-react-work";

/**
 * Clicky where the person meets it: its switch in the viewer's header, its bar under the screen and
 * its state on the panel's preview, only on a deployment that offers it. And the live screen, while
 * the person drives, keeps Clicky's Stop for itself: Control-Option-S, and Escape while Clicky is
 * acting, stop Clicky and never reach the Bot's computer.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: SocketDouble[] = [];
  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) {
    SocketDouble.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }
  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

const BOT = "clicky-viewer-bot";
let awake = true;
let narrating = false;
let stopped = false;
/** Whether the Bot is at work, as the server knows it: `watch` is taken only then. */
let botActive = false;
/** Awake, but nothing drawn on the screen: no step, no pointer. */
let bare = false;
let commands: ClickyCommand[] = [];
/** What the viewer asked of the computer's wheel, and of whom. */
let controlCalls: { path: string; body: unknown }[] = [];
let control: ControlState;
const originalFetch = globalThis.fetch;
let originalWebSocket: typeof WebSocket;

const SINCE = "2026-10-14T09:00:00Z";
function botHolds(): ControlState {
  return {
    holder: "bot",
    since: SINCE,
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
  };
}

function clickySession(botId = BOT): ClickySession {
  return {
    ...newClickySession({ id: "s1", botId, now: 0 }),
    awake,
    narrating: awake && narrating,
    state: !awake ? "idle" : stopped ? "stopped" : "guiding",
    reply: !awake
      ? null
      : narrating
        ? { text: "", final: true, notice: "watching" }
        : { text: "Click Sign in, top right.", final: true },
    overlays:
      awake && !narrating && !bare
        ? [{ kind: "pointer", id: "p1", at: { x: 0.9, y: 0.1 } }]
        : [],
    seq: commands.length + 1,
  };
}

/** The computer's wheel, as the server keeps it: asked for, taken, given back. */
function answerControl(path: string, body: unknown): Response {
  if (path.endsWith("/control/request")) {
    const asked = body as { reason: string; source?: "manual" };
    control = {
      ...control,
      requested: true,
      reason: asked.reason,
      request: {
        id: `request-${controlCalls.length}`,
        status: "waiting",
        reason: asked.reason,
        source: asked.source ?? "model",
        createdAt: SINCE,
        updatedAt: SINCE,
      },
    };
  }
  if (path.endsWith("/control/take") && control.request)
    control = {
      ...control,
      holder: "human",
      requested: false,
      request: { ...control.request, status: "taken" },
    };
  if (path.endsWith("/control/release") && control.request)
    control = {
      ...control,
      holder: "bot",
      reason: undefined,
      request: { ...control.request, status: "completed" },
    };
  return Response.json(control);
}

/** Every card is on screen at once, so the preview polls its picture straight away. */
class SeenObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() =>
      this.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
}
let originalObserver: typeof IntersectionObserver | undefined;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  control = botHolds();
  originalObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver =
    SeenObserver as unknown as typeof IntersectionObserver;
  // Whatever an earlier file left in the shared cache (a signed-out person, say) is not ours.
  queryClient.clear();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/screenshot"))
      return Response.json({
        base64: "AAAA",
        width: 1920,
        height: 1080,
        capturedAt: "2026-10-14T09:00:00Z",
        url: "https://example.com",
      });
    if (/\/control(\?|$)/.test(url)) return Response.json(control);
    if (/\/control\/(request|take|release|cancel)$/.test(url)) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      controlCalls.push({
        path: url.replace(/^.*\/control/, "/control"),
        body,
      });
      return answerControl(url, body);
    }
    const clicky = /^\/api\/computers\/([^/]+)\/clicky(\/commands)?$/.exec(url);
    if (clicky?.[1] && !clicky[2])
      return Response.json({ session: clickySession(clicky[1]) });
    if (clicky?.[1] && clicky[2]) {
      const command = JSON.parse(String(init?.body)) as ClickyCommand;
      commands.push(command);
      if (command.type === "wake") awake = true;
      if (command.type === "sleep") {
        awake = false;
        narrating = false;
        stopped = false;
      }
      if (command.type === "stop") stopped = true;
      if (command.type === "watch" && botActive) {
        awake = true;
        narrating = true;
      }
      return Response.json({ session: clickySession(clicky[1]) });
    }
    if (url === "/api/me")
      return Response.json({ user: { id: "person-1", email: "p@x.test" } });
    if (url === "/api/settings/preferences")
      return Response.json({
        preferences: { messageListEmphasis: "agent", clickyOnboarded: true },
      });
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  computerSleep.reset();
  SocketDouble.all = [];
  commands = [];
  controlCalls = [];
  control = botHolds();
  awake = true;
  narrating = false;
  stopped = false;
  bare = false;
  botActive = false;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  if (originalObserver) globalThis.IntersectionObserver = originalObserver;
  GlobalRegistrator.unregister();
});

function offerClicky(enabled: boolean) {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    ...(enabled ? { clicky: { enabled: true, voice: false } } : {}),
  });
}

/** A transcript tile for a turn still running, as `computer-tools.tsx` draws one. */
function tile(finished: boolean) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ComputerView
          active={!finished}
          computerId={BOT}
          finished={finished}
          minHeight={0}
          minWidth={0}
          toolCallId="clicky-viewer-call"
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function preview(botId = BOT) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ComputerView
          active
          computerId={botId}
          controls={false}
          minHeight={0}
          minWidth={0}
          name="Noë"
          sleeps
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function openViewer(view: ReturnType<typeof render>) {
  fireEvent.click(
    view.getByRole("button", { name: "Open the assistant's screen full size" }),
  );
  return within(
    await view.findByRole("dialog", { name: "The assistant's screen" }),
  );
}

test("awake, the preview draws none of Clicky, and the viewer has its switch and its bar", async () => {
  offerClicky(true);
  const view = preview();
  // The picture arrives; nothing of Clicky is drawn over it or under it, however awake it is.
  await waitFor(() =>
    expect(
      view.container.querySelector(
        'img[alt="What the assistant is looking at"]',
      ),
    ).toBeTruthy(),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(view.container.querySelector("[data-clicky]")).toBeNull();
  expect(view.container.querySelector("[data-clicky-state]")).toBeNull();
  expect(
    view.container.querySelector('[data-slot="clicky-overlay"]'),
  ).toBeNull();
  expect(view.queryByText("Showing you")).toBeNull();

  const viewer = await openViewer(view);
  // One name whatever its state; pressed means awake.
  const launcher = await viewer.findByRole("button", { name: "Show me how" });
  await waitFor(() =>
    expect(launcher.getAttribute("aria-pressed")).toBe("true"),
  );
  const bar = await viewer.findByRole("region", { name: "Show me how" });
  expect(within(bar).getByText("Click Sign in, top right.")).toBeTruthy();

  fireEvent.click(within(bar).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(commands).toContainEqual({ type: "stop" }));
});

test("asleep, the switch wakes Clicky and the bar appears", async () => {
  offerClicky(true);
  awake = false;
  const view = preview();
  const viewer = await openViewer(view);
  const wake = await viewer.findByRole("button", { name: "Show me how" });
  await waitFor(() => expect(wake.hasAttribute("disabled")).toBe(false));
  expect(wake.getAttribute("aria-pressed")).toBe("false");
  expect(viewer.queryByRole("region", { name: "Show me how" })).toBeNull();

  fireEvent.click(wake);
  // Opening asked to narrate, which the server refused with the Bot idle; then the switch woke it.
  await waitFor(() =>
    expect(commands).toEqual([{ type: "watch" }, { type: "wake" }]),
  );
  expect(
    await viewer.findByRole("region", { name: "Show me how" }),
  ).toBeTruthy();
});

test("without Clicky on the deployment there is no switch, no bar and no socket", async () => {
  offerClicky(false);
  const view = preview();
  const viewer = await openViewer(view);
  expect(viewer.queryByRole("button", { name: "Show me how" })).toBeNull();
  expect(viewer.queryByRole("region", { name: "Show me how" })).toBeNull();
  expect(SocketDouble.all.some((socket) => socket.url.includes("clicky"))).toBe(
    false,
  );
});

async function drivingScreen(clicky?: { acting: boolean; onStop: () => void }) {
  const view = render(
    <LiveScreen
      computerId="clicky-live"
      driving
      {...(clicky ? { clicky } : {})}
    />,
  );
  await waitFor(() =>
    expect(
      view.container.querySelector('canvas[data-connected="true"]'),
    ).toBeTruthy(),
  );
  // The keys are bound in an effect after that render; let it run before pressing anything.
  await act(async () => {});
  return SocketDouble.all.at(-1) as SocketDouble;
}

/**
 * A keystroke as a browser reports it. happy-dom says AltGraph whenever Alt is down; a browser says
 * it only for the AltGr key, so a left Control and Alt are not AltGraph here either.
 */
const press = (init: KeyboardEventInit, altGraph = false) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  const own = event.getModifierState.bind(event);
  Object.defineProperty(event, "getModifierState", {
    value: (name: string) => (name === "AltGraph" ? altGraph : own(name)),
  });
  window.dispatchEvent(event);
  return event;
};

test("while driving, Control-Option-S stops Clicky and never reaches the computer", async () => {
  let stops = 0;
  const socket = await drivingScreen({ acting: false, onStop: () => stops++ });
  // Option+S writes ß on a Mac; the key is still S.
  const shortcut = press({
    key: "ß",
    code: "KeyS",
    ctrlKey: true,
    altKey: true,
  });
  expect(shortcut.defaultPrevented).toBe(true);
  expect(stops).toBe(1);
  window.dispatchEvent(
    new KeyboardEvent("keyup", { key: "ß", code: "KeyS", bubbles: true }),
  );
  expect(socket.sent).toEqual([]);
});

test("while Clicky acts, Escape stops it rather than closing anything", async () => {
  let stops = 0;
  let escapesSeen = 0;
  const listener = (event: KeyboardEvent) => {
    if (event.key === "Escape") escapesSeen++;
  };
  window.addEventListener("keydown", listener);
  try {
    const socket = await drivingScreen({ acting: true, onStop: () => stops++ });
    press({ key: "Escape", code: "Escape" });
    expect(stops).toBe(1);
    // Stopped before the viewer's own Escape (minimize) could hear it.
    expect(escapesSeen).toBe(0);
    expect(socket.sent).toEqual([]);
  } finally {
    window.removeEventListener("keydown", listener);
  }
});

test("without Clicky awake, the same keys go to the computer as before", async () => {
  const socket = await drivingScreen();
  press({ key: "s", code: "KeyS", keyCode: 83, ctrlKey: true, altKey: true });
  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "s",
      code: "KeyS",
      text: "s",
      windowsVirtualKeyCode: 83,
      modifiers: 3,
    },
  ]);
});

test("Escape in Clicky's menu closes the menu, not the viewer", async () => {
  offerClicky(true);
  const view = preview();
  const viewer = await openViewer(view);
  const bar = await viewer.findByRole("region", { name: "Show me how" });
  fireEvent.click(within(bar).getByRole("button", { name: "More options" }));
  const menu = await view.findByRole("menu");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(view.queryByRole("menu")).toBeNull());
  expect(
    view.baseElement.querySelector('[aria-label="The assistant\'s screen"]'),
  ).toBeTruthy();
});

test("while driving, keys pressed in Clicky's own controls stay in the page", async () => {
  const socket = await drivingScreen({ acting: false, onStop: () => {} });
  const menu = document.createElement("div");
  menu.setAttribute("data-clicky-ui", "");
  const item = document.createElement("button");
  menu.append(item);
  document.body.append(menu);
  try {
    for (const key of ["ArrowDown", "Enter", " "])
      item.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    expect(socket.sent).toEqual([]);
  } finally {
    menu.remove();
  }
});

test("AltGr and S, which writes a letter on some keyboards, is not Stop and reaches the computer", async () => {
  let stops = 0;
  const socket = await drivingScreen({ acting: false, onStop: () => stops++ });
  press(
    { key: "ś", code: "KeyS", keyCode: 83, ctrlKey: true, altKey: true },
    true,
  );
  expect(stops).toBe(0);
  expect(socket.sent).toHaveLength(1);
});

const requests = () =>
  controlCalls.filter((call) => call.path === "/control/request");

test("guiding the person, the viewer takes the computer for them with Show me how's reason, once", async () => {
  offerClicky(true);
  const view = preview();
  const viewer = await openViewer(view);
  await waitFor(() =>
    expect(controlCalls.map((call) => call.path)).toEqual([
      "/control/request",
      "/control/take",
    ]),
  );
  expect(requests()[0]?.body).toEqual({ reason: CLICKY_HELP_REASON });
  // The status pill says why, in words of its own rather than the reason's English.
  expect(
    await viewer.findByText(
      "You have control — click and type on the page. Show me how is helping you here.",
    ),
  ).toBeTruthy();

  // Control drifts back to the Bot; the control poll draws the viewer again, and nothing is taken
  // twice in one session.
  control = botHolds();
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  expect(requests()).toHaveLength(1);
});

test("stopped, Show me how gives back the computer it took", async () => {
  offerClicky(true);
  const view = preview();
  const viewer = await openViewer(view);
  await waitFor(() => expect(control.holder).toBe("human"));
  const bar = await viewer.findByRole("region", { name: "Show me how" });
  fireEvent.click(within(bar).getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(controlCalls.map((call) => call.path)).toContain("/control/release"),
  );
  expect(control.holder).toBe("bot");
});

test("control the person took themselves is not given back when Show me how stops", async () => {
  offerClicky(true);
  control = {
    ...botHolds(),
    holder: "human",
    reason: "I want to take control of the browser.",
    request: {
      id: "mine",
      status: "taken",
      reason: "I want to take control of the browser.",
      source: "manual",
      createdAt: SINCE,
      updatedAt: SINCE,
    },
  };
  const view = preview();
  const viewer = await openViewer(view);
  const bar = await viewer.findByRole("region", { name: "Show me how" });
  fireEvent.click(within(bar).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(commands).toContainEqual({ type: "stop" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(controlCalls).toEqual([]);
});

test("narrating the Bot at work, the viewer never takes the computer", async () => {
  offerClicky(true);
  narrating = true;
  const view = preview();
  const viewer = await openViewer(view);
  await viewer.findByRole("region", { name: "Show me how" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(controlCalls).toEqual([]);
});

test("minimizing puts Show me how to sleep, never Stop", async () => {
  offerClicky(true);
  const view = preview();
  const viewer = await openViewer(view);
  await viewer.findByRole("region", { name: "Show me how" });
  fireEvent.click(viewer.getByRole("button", { name: "Minimize screen" }));
  await waitFor(() => expect(commands).toContainEqual({ type: "sleep" }));
  expect(commands).not.toContainEqual({ type: "stop" });
  await waitFor(() =>
    expect(
      view.queryByRole("dialog", { name: "The assistant's screen" }),
    ).toBeNull(),
  );
  // Once, though the viewer closing would also put it to sleep.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(commands.filter((command) => command.type === "sleep")).toHaveLength(
    1,
  );
});

test("the viewer going away (the page changed) puts Show me how to sleep too", async () => {
  offerClicky(true);
  const view = preview();
  const viewer = await openViewer(view);
  await viewer.findByRole("region", { name: "Show me how" });
  view.unmount();
  await waitFor(() => expect(commands).toContainEqual({ type: "sleep" }));
});

test("opened on a sleeping session, the viewer asks to narrate; with the Bot idle, the server says no", async () => {
  offerClicky(true);
  awake = false;
  const view = preview("clicky-viewer-idle-bot");
  const viewer = await openViewer(view);
  await waitFor(() => expect(commands).toEqual([{ type: "watch" }]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Asked once, and nothing drawn: the session is asleep as it was.
  expect(commands).toEqual([{ type: "watch" }]);
  expect(viewer.queryByRole("region", { name: "Show me how" })).toBeNull();
});

test("opened while the Bot works, Show me how narrates it, and takes nothing", async () => {
  offerClicky(true);
  awake = false;
  botActive = true;
  const view = preview("clicky-viewer-busy-bot");
  const viewer = await openViewer(view);
  await waitFor(() => expect(commands).toEqual([{ type: "watch" }]));
  const bar = await viewer.findByRole("region", { name: "Show me how" });
  expect(
    within(bar).getByText("I'll show you what Noë Bot is doing."),
  ).toBeTruthy();
  // Watching takes nothing.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(controlCalls).toEqual([]);
});

test("opened on an awake session, or while somebody drives, nothing asks to narrate", async () => {
  offerClicky(true);
  botActive = true;
  // A walkthrough under way.
  const awakeView = preview("clicky-viewer-guiding-bot");
  const awakeViewer = await openViewer(awakeView);
  await awakeViewer.findByRole("region", { name: "Show me how" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(commands).not.toContainEqual({ type: "watch" });
  awakeView.unmount();

  // Asleep, but the person holds the computer.
  awake = false;
  commands = [];
  control = {
    ...botHolds(),
    holder: "human",
    request: {
      id: "mine",
      status: "taken",
      reason: "I want to take control of the browser.",
      source: "manual",
      createdAt: SINCE,
      updatedAt: SINCE,
    },
  };
  const drivenView = preview("clicky-viewer-driven-bot");
  const drivenViewer = await openViewer(drivenView);
  await drivenViewer.findByRole("button", { name: "Show me how" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(commands).not.toContainEqual({ type: "watch" });
});

test("what counts as guiding the person, and as the end of it", () => {
  const base = {
    ...newClickySession({ id: "s1", botId: BOT, now: 0 }),
    overlays: [{ kind: "pointer" as const, id: "p1", at: { x: 0.5, y: 0.5 } }],
  };
  // Awake and guiding, with something on the screen: take. Narrating: never.
  expect(
    selectGuidance({ ...base, awake: true, state: "guiding" }).guiding,
  ).toBe(true);
  expect(
    selectGuidance({ ...base, awake: true, state: "guiding", narrating: true })
      .guiding,
  ).toBe(false);
  // Awake with nothing drawn (narration just ended, a plain answer): nobody to guide.
  expect(
    selectGuidance({ ...base, awake: true, state: "guiding", overlays: [] })
      .guiding,
  ).toBe(false);
  // A sign-in or a secret is answered in the conversation's form, not on the screen.
  expect(
    selectGuidance({
      ...base,
      awake: true,
      state: "guiding",
      trigger: { kind: "sign_in" },
    }).inForm,
  ).toBe(true);
  // Asleep, stopped, or the walkthrough done: give back.
  expect(selectGuidance({ ...base, awake: false }).ended).toBe(true);
  expect(selectGuidance({ ...base, awake: true, state: "stopped" }).ended).toBe(
    true,
  );
  expect(
    selectGuidance({
      ...base,
      awake: true,
      state: "idle",
      reply: { text: "", final: true, notice: "walkthrough_done" },
    }).ended,
  ).toBe(true);
  // Done is given back a moment later (the finishing click still has to land); asleep, at once.
  expect(
    selectGuidance({
      ...base,
      awake: true,
      state: "idle",
      reply: { text: "", final: true, notice: "walkthrough_done" },
    }).done,
  ).toBe(true);
  expect(selectGuidance({ ...base, awake: false }).done).toBe(false);
  expect(selectGuidance({ ...base, awake: true, state: "stopped" }).done).toBe(
    false,
  );
});

test("narration is only ever asked for over a session nobody is using", () => {
  expect(
    mayWatch({ awake: false, narrating: false, state: "idle", trigger: null }),
  ).toBe(true);
  // Awake, it shows something already: a walkthrough, an answer, the Bot asking, narration itself.
  for (const view of [
    { state: "idle" as const, trigger: "person" as const, narrating: false },
    { state: "guiding" as const, trigger: "person" as const, narrating: false },
    {
      state: "thinking" as const,
      trigger: "person" as const,
      narrating: false,
    },
    { state: "idle" as const, trigger: "takeover" as const, narrating: false },
    { state: "guiding" as const, trigger: "person" as const, narrating: true },
  ])
    expect(mayWatch({ awake: true, ...view })).toBe(false);
});

test("awake with nothing on the screen to guide, the viewer takes nothing", async () => {
  offerClicky(true);
  bare = true;
  const view = preview();
  const viewer = await openViewer(view);
  await viewer.findByRole("region", { name: "Show me how" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(controlCalls).toEqual([]);
});

test("a chat card's turn finishing under the open viewer does not put Show me how to sleep; closing does", async () => {
  offerClicky(true);
  const view = render(tile(false));
  const viewer = await openViewer(view);
  await viewer.findByRole("region", { name: "Show me how" });

  // The turn ends: the viewer stays open on its record, and Show me how is left as it was.
  view.rerender(tile(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(
    view.queryByRole("dialog", { name: "The assistant's screen" }),
  ).toBeTruthy();
  expect(commands).not.toContainEqual({ type: "sleep" });

  view.unmount();
  await waitFor(() => expect(commands).toContainEqual({ type: "sleep" }));
});
