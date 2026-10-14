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

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Whatever an earlier file left in the shared cache (a signed-out person, say) is not ours.
  queryClient.clear();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
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

test("awake, Clicky shows on the preview, and the viewer has its switch and its bar", async () => {
  offerClicky(true);
  const view = preview();
  // The panel's card says where Clicky is.
  const row = await waitFor(() => {
    const found = view.container.querySelector(
      '[data-slot="clicky-panel-row"]',
    );
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
  await waitFor(() =>
    expect(within(row).getByText("Showing you")).toBeTruthy(),
  );

  const viewer = await openViewer(view);
  expect(
    viewer
      .getByRole("button", { name: "Put Clicky to sleep" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  const bar = await viewer.findByRole("region", { name: "Clicky" });
  expect(within(bar).getByText("Click Sign in, top right.")).toBeTruthy();

  fireEvent.click(within(bar).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(commands).toEqual([{ type: "stop" }]));
});

test("asleep, the switch wakes Clicky and the bar appears", async () => {
  offerClicky(true);
  awake = false;
  const view = preview();
  const viewer = await openViewer(view);
  const wake = await viewer.findByRole("button", { name: "Wake Clicky" });
  await waitFor(() => expect(wake.hasAttribute("disabled")).toBe(false));
  expect(viewer.queryByRole("region", { name: "Clicky" })).toBeNull();

  fireEvent.click(wake);
  await waitFor(() => expect(commands).toEqual([{ type: "wake" }]));
  expect(await viewer.findByRole("region", { name: "Clicky" })).toBeTruthy();
});

test("without Clicky on the deployment there is no switch, no bar and no socket", async () => {
  offerClicky(false);
  const view = preview();
  const viewer = await openViewer(view);
  expect(viewer.queryByRole("button", { name: "Wake Clicky" })).toBeNull();
  expect(viewer.queryByRole("region", { name: "Clicky" })).toBeNull();
  expect(
    view.container.querySelector('[data-slot="clicky-panel-row"]'),
  ).toBeNull();
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

const press = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
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
