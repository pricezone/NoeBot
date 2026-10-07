import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { LiveScreen } from "@/components/computer/live-screen";
import { RecordStepsButton } from "@/components/computer/record-steps-button";
import { queryClient } from "@/query-client";

/**
 * This page's own fields while a person drives a Bot's browser.
 *
 * LiveScreen takes every keystroke on the window while someone holds the wheel, because the canvas
 * cannot hold focus. The full-window viewer also carries fields of its own, the workflow name asked
 * for once a recording stops and the secret box, and taking their keys left them dead: typing into
 * "Workflow name" did nothing, and every letter went to the Bot's browser instead. The name is asked
 * for in a dialog that opens over the screen while the person is still driving, so its buttons'
 * keys belong to it too.
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

const requests: { method: string; url: string; body: unknown }[] = [];

/** One recording on the server double, from nothing to stopped. */
let recording: "none" | "recording" | "stopped" = "none";
const demonstration = (title = "Untitled workflow") => ({
  id: "d1",
  botId: "fields-test",
  title,
  status: recording === "recording" ? "recording" : "stopped",
  actions: [
    {
      kind: "click",
      target: { role: "button", name: "Search", sensitive: false },
    },
  ],
  draft: null,
  skillSlug: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  maxDurationMs: 600_000,
  reachedTimeLimit: false,
});

let originalWebSocket: typeof WebSocket;
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  originalFetch = globalThis.fetch;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, body });
    if (url.includes("/control"))
      return Response.json({ holder: "human", transitioning: false });
    if (url === "/api/demonstrations" && method === "POST") {
      recording = "recording";
      return Response.json({ demonstration: demonstration() }, { status: 201 });
    }
    if (url === "/api/demonstrations/d1/stop") {
      recording = "stopped";
      return Response.json({ demonstration: demonstration() });
    }
    if (url === "/api/demonstrations/d1" && method === "PATCH")
      return Response.json({
        demonstration: demonstration((body as { title: string }).title),
      });
    if (url.startsWith("/api/demonstrations?"))
      return Response.json({
        demonstrations: recording === "none" ? [] : [demonstration()],
      });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  requests.length = 0;
  recording = "none";
  SocketDouble.latest = undefined;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function Field() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="Workflow name"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

async function driving(extra?: React.ReactNode) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LiveScreen computerId="fields-test" driving />
      {extra}
    </QueryClientProvider>,
  );
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;
  // Input is sent only once ownership is confirmed; wait for the screen to say so.
  await waitFor(() =>
    expect(document.querySelector("canvas")?.dataset.connected).toBe("true"),
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { socket, view, user };
}

test("typing into a field on this page while driving fills it and sends nothing", async () => {
  const { socket, view, user } = await driving(<Field />);
  const field = view.getByLabelText("Workflow name") as HTMLInputElement;

  await user.click(field);
  await user.keyboard("Find an invoice");

  expect(field.value).toBe("Find an invoice");
  expect(socket.sent).toEqual([]);
});

test("a paste into a field on this page stays in the field", async () => {
  const { socket, view } = await driving(<Field />);
  const field = view.getByLabelText("Workflow name");
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "invoice" },
  });

  field.dispatchEvent(paste);

  expect(paste.defaultPrevented).toBe(false);
  expect(socket.sent).toEqual([]);
});

test("keys with no field focused still go to the Bot's browser", async () => {
  const { socket } = await driving(<Field />);
  const key = new KeyboardEvent("keydown", {
    key: "a",
    code: "KeyA",
    keyCode: 65,
    bubbles: true,
    cancelable: true,
  });

  document.body.dispatchEvent(key);

  expect(key.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      windowsVirtualKeyCode: 65,
      modifiers: 0,
    },
  ]);
});

test("recording, then naming the workflow in the dialog over the screen, sends no keys to the Bot", async () => {
  const { socket, view, user } = await driving(
    <RecordStepsButton
      botId="fields-test"
      driving
      onRecordingChange={() => {}}
    />,
  );

  await user.click(view.getByRole("button", { name: "Record your steps" }));
  await user.click(await view.findByRole("button", { name: "Stop recording" }));
  const name = (await view.findByLabelText(
    "Workflow name",
  )) as HTMLInputElement;
  await user.click(name);
  await user.keyboard("Find an invoice");
  expect(name.value).toBe("Find an invoice");
  // Tab to Later and on to Save stays in the dialog rather than steering the Bot's browser.
  await user.keyboard("{Tab}{Tab}");
  expect(document.activeElement?.textContent).toBe("Save");
  await user.keyboard("{Enter}");

  await waitFor(() =>
    expect(requests.filter((request) => request.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        url: "/api/demonstrations/d1",
        body: { title: "Find an invoice" },
      },
    ]),
  );
  expect(
    requests.filter(
      (request) =>
        request.method === "POST" && request.url === "/api/demonstrations",
    ),
  ).toEqual([
    {
      method: "POST",
      url: "/api/demonstrations",
      body: { botId: "fields-test", title: "Untitled workflow" },
    },
  ]);
  expect(socket.sent.filter((message) => message.type === "key")).toEqual([]);
});
