import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(_url: string) {
    SocketDouble.latest = this;
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

type ObserverEntry = {
  observer: IntersectionObserverDouble;
  target: Element;
};

class IntersectionObserverDouble {
  static observed: ObserverEntry[] = [];

  constructor(
    private readonly callback: IntersectionObserverCallback,
    _options?: IntersectionObserverInit,
  ) {}

  observe(target: Element) {
    IntersectionObserverDouble.observed.push({ observer: this, target });
  }

  unobserve(target: Element) {
    IntersectionObserverDouble.observed =
      IntersectionObserverDouble.observed.filter(
        (entry) => entry.observer !== this || entry.target !== target,
      );
  }

  disconnect() {
    IntersectionObserverDouble.observed =
      IntersectionObserverDouble.observed.filter(
        (entry) => entry.observer !== this,
      );
  }

  fire(target: Element, isIntersecting: boolean) {
    this.callback(
      [
        {
          target,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

let originalWebSocket: typeof WebSocket;
let originalCreateImageBitmap: typeof createImageBitmap | undefined;
let originalFetch: typeof fetch;
let originalIntersectionObserver: typeof IntersectionObserver | undefined;
let originalCanvasGetContext: typeof HTMLCanvasElement.prototype.getContext;
let originalImageDecode: typeof HTMLImageElement.prototype.decode | undefined;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  originalCreateImageBitmap = globalThis.createImageBitmap;
  originalFetch = globalThis.fetch;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  originalCanvasGetContext = HTMLCanvasElement.prototype.getContext;
  originalImageDecode = HTMLImageElement.prototype.decode;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.IntersectionObserver =
    IntersectionObserverDouble as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  SocketDouble.latest = undefined;
  IntersectionObserverDouble.observed = [];
  globalThis.fetch = originalFetch;
  if (originalCreateImageBitmap) {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  } else {
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
  HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
  if (originalImageDecode) {
    HTMLImageElement.prototype.decode = originalImageDecode;
  } else {
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  }
  setVisibility("visible");
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  if (originalIntersectionObserver) {
    globalThis.IntersectionObserver = originalIntersectionObserver;
  } else {
    Reflect.deleteProperty(globalThis, "IntersectionObserver");
  }
  if (originalCreateImageBitmap) {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  } else {
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
  HTMLCanvasElement.prototype.getContext = originalCanvasGetContext;
  if (originalImageDecode) {
    HTMLImageElement.prototype.decode = originalImageDecode;
  } else {
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  }
  GlobalRegistrator.unregister();
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state !== "visible",
  });
}

type Handler = (path: string) => Response | Promise<Response> | undefined;

function serve(handler: Handler): string[] {
  const paths: string[] = [];
  globalThis.fetch = (async (input) => {
    const path = String(input);
    paths.push(path);
    const answered = await handler(path);
    if (answered) return answered;
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return paths;
}

const frame = (url = "https://example.com") =>
  Response.json({
    base64: "AAAA",
    width: 320,
    height: 200,
    capturedAt: new Date(0).toISOString(),
    url,
  });

const control = (holder: "bot" | "human") =>
  Response.json({
    holder,
    since: new Date(0).toISOString(),
    requested: holder === "human",
    ...(holder === "human"
      ? { request: { id: "r1", status: "taken", reason: "x" } }
      : {}),
  });

const shots = (paths: string[]) =>
  paths.filter((path) => path.includes("screenshot")).length;

function intersect() {
  const entry = IntersectionObserverDouble.observed.at(0);
  entry?.observer.fire(entry.target, true);
}

test("a desktop preview nobody is driving asks for a frame every few seconds, not every tick", async () => {
  const paths = serve((path) => {
    if (path.endsWith("/control")) return control("bot");
    if (path.endsWith("/status"))
      return Response.json({ desktop: { width: 1440, height: 900 } });
    if (path.endsWith("/desktop/screenshot")) return frame();
    return undefined;
  });

  render(<ComputerView computerId="desktop-preview" active intervalMs={10} />);
  await act(async () => {
    intersect();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  // One frame, then the next only after the desktop interval: ten-millisecond ticks would be twenty.
  expect(shots(paths)).toBeGreaterThanOrEqual(1);
  expect(shots(paths)).toBeLessThanOrEqual(2);
});

test("a page preview still follows its own interval", async () => {
  const paths = serve((path) => {
    if (path.endsWith("/control")) return control("bot");
    if (path.endsWith("/status")) return Response.json({ desktop: null });
    if (path.endsWith("/screenshot")) return frame();
    return undefined;
  });

  render(<ComputerView computerId="page-preview" active intervalMs={10} />);
  await act(async () => {
    intersect();
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  expect(shots(paths)).toBeGreaterThan(3);
});

test("the full-window viewer on a live stream stops the screenshot polling under it", async () => {
  HTMLCanvasElement.prototype.getContext = (() =>
    ({
      drawImage: () => undefined,
    }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  const paths = serve((path) => {
    if (path.endsWith("/control")) return control("human");
    if (path.endsWith("/status")) return Response.json({ desktop: null });
    if (path.endsWith("/screenshot")) return frame();
    return undefined;
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ComputerView computerId="viewer-live" active intervalMs={10} />
    </QueryClientProvider>,
  );
  await act(async () => {
    intersect();
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  expect(shots(paths)).toBeGreaterThan(1);

  const open = await view.findByRole("button", {
    name: "Open the assistant's screen full size",
  });
  await act(async () => {
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const whenOpened = shots(paths);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  expect(shots(paths)).toBe(whenOpened);
});
