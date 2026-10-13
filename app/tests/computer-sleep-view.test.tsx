import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { ComputerTab } from "@/components/bot-panel/computer-tab";
import { ComputerView } from "@/components/computer/computer-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { computerSleep } from "@/lib/computers/use-computer-sleep";
import { settleReactWork } from "./settle-react-work";

/**
 * The bot panel's screen, and the viewer it opens, asleep.
 *
 * Asleep, neither asks the computer for anything: no screenshot, no live stream. Both show the Bot
 * dozing with "Computer is asleep" and a Wake pill, and waking starts the frames again at once. A
 * computer whose browser has stopped opens that way rather than being started for a picture, and
 * anybody needed at the computer (a hand-off, a secret) keeps it awake.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;
  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {
    SocketDouble.latest = this;
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

const BOT = "sleep-view-bot";
let browser: "running" | "stopped" | undefined;
let requested = false;
let paths: string[] = [];

let originalFetch: typeof fetch;
let originalWebSocket: typeof WebSocket;
let originalIntersectionObserver: unknown;
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  // Without an observer the card counts as on screen, which is what the panel is when it is open.
  originalIntersectionObserver = Reflect.get(window, "IntersectionObserver");
  Reflect.deleteProperty(window, "IntersectionObserver");
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() =>
    ({
      drawImage: () => undefined,
    }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/control"))
      return Response.json({
        holder: "bot",
        since: "2026-10-13T09:00:00Z",
        requested,
        ...(requested ? { reason: "Please sign in." } : {}),
        transitioning: false,
        resumeSnapshotRequired: false,
      });
    if (path.endsWith("/status"))
      return Response.json({
        botId: BOT,
        state: "ready",
        ...(browser ? { browser } : {}),
      });
    if (path.endsWith("/screenshot"))
      return Response.json({
        base64: "AAAA",
        width: 1280,
        height: 800,
        capturedAt: "2026-10-13T09:00:00Z",
        url: "https://example.com/",
      });
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  computerSleep.reset();
  browser = undefined;
  requested = false;
  paths = [];
  SocketDouble.latest = undefined;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  if (originalIntersectionObserver)
    Reflect.set(window, "IntersectionObserver", originalIntersectionObserver);
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  GlobalRegistrator.unregister();
});

const shots = () => paths.filter((path) => path.endsWith("/screenshot")).length;
const pause = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The panel's card, the way `ComputerTab` draws it. */
function card() {
  return render(
    <QueryClientProvider client={client()}>
      <TooltipProvider>
        <ComputerView
          active
          caption="Noë's screen"
          computerId={BOT}
          controls={false}
          intervalMs={10}
          minHeight={0}
          minWidth={0}
          name="Noë"
          sleeps
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

test("asleep, the card says so, offers Wake, and asks the computer for no frame at all", async () => {
  computerSleep.sleep(BOT);
  const view = card();
  await pause(150);

  expect(view.getByText("Computer is asleep")).toBeTruthy();
  expect(view.getByRole("button", { name: "Wake" })).toBeTruthy();
  expect(shots()).toBe(0);
  // Nothing to open while asleep: the card is the Bot dozing, not a screen.
  expect(
    view.queryByRole("button", {
      name: "Open the assistant's screen full size",
    }),
  ).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Wake" }));
  await waitFor(() => expect(shots()).toBeGreaterThan(0));
  expect(view.queryByText("Computer is asleep")).toBeNull();
});

test("a click anywhere on the sleeping card wakes it", async () => {
  computerSleep.sleep(BOT);
  const view = card();
  await pause(20);
  const target = view.container.querySelector(
    'button[aria-hidden="true"]',
  ) as HTMLButtonElement;
  fireEvent.click(target);
  await waitFor(() => expect(shots()).toBeGreaterThan(0));
});

test("a browser the computer says has stopped opens asleep, and is not started for a picture", async () => {
  browser = "stopped";
  const view = card();

  expect(await view.findByText("Computer is asleep")).toBeTruthy();
  await pause(100);
  expect(paths.some((path) => path.endsWith(`/${BOT}/status`))).toBe(true);
  expect(shots()).toBe(0);

  // Wake is what asks for the first frame, which starts the browser (and its saved tabs) again.
  fireEvent.click(view.getByRole("button", { name: "Wake" }));
  await waitFor(() => expect(shots()).toBeGreaterThan(0));
});

test("a running browser opens awake", async () => {
  browser = "running";
  const view = card();
  await waitFor(() => expect(shots()).toBeGreaterThan(1));
  expect(view.queryByText("Computer is asleep")).toBeNull();
});

test("going to sleep stops the polling", async () => {
  const view = card();
  await waitFor(() => expect(shots()).toBeGreaterThan(1));

  await act(async () => computerSleep.sleep(BOT));
  expect(view.getByText("Computer is asleep")).toBeTruthy();
  // At most the one already on its way.
  const settled = shots() + 1;
  await pause(150);
  expect(shots()).toBeLessThanOrEqual(settled);
});

test("somebody needed at the computer keeps it awake", async () => {
  requested = true;
  computerSleep.sleep(BOT);
  const view = card();
  await waitFor(() => expect(shots()).toBeGreaterThan(0));
  expect(view.queryByText("Computer is asleep")).toBeNull();
  expect(view.getByText("The assistant needs you.")).toBeTruthy();
});

test("the viewer, asleep: the stream closes and the Bot dozes in its place, with Wake", async () => {
  const view = card();
  await waitFor(() => expect(shots()).toBeGreaterThan(0));
  fireEvent.click(
    await view.findByRole("button", {
      name: "Open the assistant's screen full size",
    }),
  );
  const dialog = await view.findByRole("dialog", {
    name: "The assistant's screen",
  });
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;

  await act(async () => computerSleep.sleep(BOT));
  const viewer = within(dialog);
  expect(viewer.getByText("Computer is asleep")).toBeTruthy();
  expect(socket.readyState).toBe(SocketDouble.CLOSED);
  const before = shots();
  await pause(100);
  expect(shots()).toBeLessThanOrEqual(before + 1);

  fireEvent.click(viewer.getByRole("button", { name: "Wake" }));
  await waitFor(() =>
    expect(viewer.queryByText("Computer is asleep")).toBeNull(),
  );
});

test("a click in the viewer is somebody using the computer", async () => {
  const view = card();
  await waitFor(() => expect(shots()).toBeGreaterThan(0));
  fireEvent.click(
    await view.findByRole("button", {
      name: "Open the assistant's screen full size",
    }),
  );
  const dialog = await view.findByRole("dialog", {
    name: "The assistant's screen",
  });
  await act(async () => computerSleep.sleep(BOT));
  fireEvent.click(dialog);
  expect(computerSleep.isAsleep(BOT)).toBe(false);
});

test("in the panel, a click or a key anywhere in the Computer tab wakes it", async () => {
  computerSleep.sleep(BOT);
  const view = render(
    <QueryClientProvider client={client()}>
      <TooltipProvider>
        <ComputerTab agentId={BOT} name="Noë" paused={false} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  expect(await view.findByText("Computer is asleep")).toBeTruthy();
  expect(view.getByText("Noë's screen")).toBeTruthy();

  fireEvent.click(view.getByRole("heading", { name: "Activity" }));
  expect(computerSleep.isAsleep(BOT)).toBe(false);
  await waitFor(() => expect(shots()).toBeGreaterThan(0));

  await act(async () => computerSleep.sleep(BOT));
  fireEvent.keyDown(view.getByRole("region", { name: "Computer sidebar" }), {
    key: "Tab",
  });
  expect(computerSleep.isAsleep(BOT)).toBe(false);
});
