import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";
import { LiveScreen } from "@/components/computer/live-screen";
import { TooltipProvider } from "@/components/ui/tooltip";
import { computerSleep } from "@/lib/computers/use-computer-sleep";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import {
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
let commands: ClickyCommand[] = [];
const originalFetch = globalThis.fetch;
let originalWebSocket: typeof WebSocket;

function clickySession(): ClickySession {
  return {
    ...newClickySession({ id: "s1", botId: BOT, now: 0 }),
    awake,
    state: awake ? "guiding" : "idle",
    reply: awake ? { text: "Click Sign in, top right.", final: true } : null,
    overlays: awake
      ? [{ kind: "pointer", id: "p1", at: { x: 0.9, y: 0.1 } }]
      : [],
    seq: commands.length + 1,
  };
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
    if (url.endsWith("/control"))
      return Response.json({
        holder: "bot",
        since: "2026-10-14T09:00:00Z",
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      });
    if (url === `/api/computers/${BOT}/clicky`)
      return Response.json({ session: clickySession() });
    if (url === `/api/computers/${BOT}/clicky/commands`) {
      const command = JSON.parse(String(init?.body)) as ClickyCommand;
      commands.push(command);
      if (command.type === "wake") awake = true;
      if (command.type === "sleep") awake = false;
      return Response.json({ session: clickySession() });
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
  awake = true;
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

function preview() {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ComputerView
          active
          computerId={BOT}
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
  await waitFor(() => expect(commands).toEqual([{ type: "wake" }]));
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
