import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClickyBar } from "@/components/clicky/clicky-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import {
  type ClickyCommand,
  type ClickySession,
  newClickySession,
} from "../../shared/clicky";
import { settleReactWork } from "./settle-react-work";

/**
 * Clicky's bar under the screen. Holding the microphone tells Clicky it is being listened to,
 * records, and on release transcribes, ends the listening and asks with the words; a tap shorter
 * than a quarter of a second asks nothing. Stop is always there; Next and Back move through a
 * walkthrough; a command the server refuses says why in Clicky's own words.
 */

const BOT = "bar-bot";
let commands: ClickyCommand[] = [];
let transcriptions = 0;
let rejectNext: string | null = null;
let preferences: Record<string, unknown> = {};
const originalFetch = globalThis.fetch;
const originalMediaRecorder = globalThis.MediaRecorder;

/** A recorder that has a little audio to give whenever it is stopped. */
class RecorderDouble {
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: unknown, options: { mimeType: string }) {
    this.mimeType = options.mimeType;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({
        data: new Blob(["sound"], { type: this.mimeType }),
      });
      this.onstop?.();
    });
  }
}

function sessionAt(seq: number, patch: Partial<ClickySession> = {}) {
  return {
    ...newClickySession({ id: "s1", botId: BOT, now: 0 }),
    awake: true,
    seq,
    ...patch,
  };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Whatever an earlier file left in the shared cache (a signed-out person, say) is not ours.
  queryClient.clear();
  globalThis.MediaRecorder = RecorderDouble as unknown as typeof MediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `/api/computers/${BOT}/clicky/commands`) {
      const command = JSON.parse(String(init?.body)) as ClickyCommand;
      commands.push(command);
      const rejected = rejectNext;
      rejectNext = null;
      return Response.json({
        session: sessionAt(commands.length + 1),
        ...(rejected ? { rejected } : {}),
      });
    }
    if (url === "/api/audio/transcriptions") {
      transcriptions += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-openbot-dictation"]).toBe("1");
      return Response.json({ text: "Where do I sign in?" });
    }
    if (url === "/api/me")
      return Response.json({
        user: { id: "person-1", email: "p@example.com" },
      });
    if (url === "/api/settings/preferences")
      return Response.json({ preferences });
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  preferences = { messageListEmphasis: "agent", clickyOnboarded: true };
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    clicky: { enabled: true, voice: true },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  commands = [];
  transcriptions = 0;
  rejectNext = null;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.MediaRecorder = originalMediaRecorder;
  GlobalRegistrator.unregister();
});

function draw(session: ClickySession = sessionAt(1)) {
  return render(
    <TooltipProvider>
      <ClickyBar botId={BOT} session={session} />
    </TooltipProvider>,
  );
}

const hold = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

test("holding the microphone listens, and letting go transcribes, stops listening and asks", async () => {
  const view = draw();
  const mic = view.getByRole("button", { name: "Hold to talk" });

  fireEvent.pointerDown(mic, { pointerId: 1 });
  await waitFor(() =>
    expect(commands).toEqual([{ type: "listen", active: true }]),
  );
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Release to send" })).toBeTruthy(),
  );
  await hold(300);

  fireEvent.pointerUp(mic, { pointerId: 1 });
  await waitFor(() =>
    expect(commands).toEqual([
      { type: "listen", active: true },
      { type: "listen", active: false },
      { type: "ask", text: "Where do I sign in?" },
    ]),
  );
  expect(transcriptions).toBe(1);
});

test("a tap shorter than a quarter of a second asks nothing", async () => {
  const view = draw();
  const mic = view.getByRole("button", { name: "Hold to talk" });

  fireEvent.pointerDown(mic, { pointerId: 1 });
  fireEvent.pointerUp(mic, { pointerId: 1 });

  await waitFor(() =>
    expect(commands).toEqual([
      { type: "listen", active: true },
      { type: "listen", active: false },
    ]),
  );
  await hold(50);
  expect(transcriptions).toBe(0);
  expect(commands).toHaveLength(2);
});

test("no microphone where the deployment cannot listen", () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    clicky: { enabled: true, voice: false },
  });
  const view = draw();
  expect(view.queryByRole("button", { name: "Hold to talk" })).toBeNull();
  expect(view.getByRole("textbox", { name: "Ask Clicky" })).toBeTruthy();
});

test("Stop sends stop, and a typed question is asked", async () => {
  const view = draw(sessionAt(1, { state: "acting" }));
  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(commands).toEqual([{ type: "stop" }]));

  const box = view.getByRole("textbox", { name: "Ask Clicky" });
  const user = userEvent.setup({ document });
  await user.type(box, "  What is this button?  ");
  expect(
    view.getByRole("button", { name: "Ask" }).hasAttribute("disabled"),
  ).toBe(false);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(commands).toEqual([
      { type: "stop" },
      { type: "ask", text: "What is this button?" },
    ]),
  );
  expect((box as HTMLInputElement).value).toBe("");
});

test("a walkthrough shows its step, and Next, Back and Show me again move through it", async () => {
  const view = draw(
    sessionAt(1, {
      state: "guiding",
      walkthrough: {
        id: "w1",
        goal: "Sign in",
        startedAt: "",
        updatedAt: "",
        currentStepId: "b",
        steps: [
          { id: "a", title: "Open the menu", status: "done", overlays: [] },
          { id: "b", title: "Click Sign in", status: "current", overlays: [] },
          {
            id: "c",
            title: "Type your email",
            status: "pending",
            overlays: [],
          },
          { id: "d", title: "Press Continue", status: "pending", overlays: [] },
        ],
      },
    }),
  );
  expect(view.getByText("Step 2 of 4 — Click Sign in")).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Next" }));
  fireEvent.click(view.getByRole("button", { name: "Back" }));
  fireEvent.click(view.getByRole("button", { name: "Show me again" }));
  await waitFor(() =>
    expect(commands).toEqual([
      { type: "next" },
      { type: "back" },
      { type: "show_me" },
    ]),
  );
});

test("on the first step there is no going back", () => {
  const view = draw(
    sessionAt(1, {
      state: "guiding",
      walkthrough: {
        id: "w1",
        goal: "Sign in",
        startedAt: "",
        updatedAt: "",
        currentStepId: "a",
        steps: [
          { id: "a", title: "Open the menu", status: "current", overlays: [] },
          { id: "b", title: "Click Sign in", status: "pending", overlays: [] },
        ],
      },
    }),
  );
  expect(
    view.getByRole("button", { name: "Back" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("a refused command says why, in Clicky's words", async () => {
  rejectNext = "busy";
  const view = draw();
  fireEvent.click(view.getByRole("button", { name: "Pause" }));
  expect(
    await view.findByText("One moment, I'm still working on the last thing."),
  ).toBeTruthy();
});

test("the reply shows Clicky's line, a failed look offers Retry, and guide only disables Do it for me", async () => {
  preferences = {
    messageListEmphasis: "agent",
    clickyOnboarded: true,
    clickyActionPolicy: "never",
  };
  const view = draw(
    sessionAt(1, {
      state: "idle",
      reply: { text: "", final: true, notice: "think_failed" },
      error: { notice: "think_failed" },
    }),
  );
  expect(
    view.getByText("I couldn't look at the screen just now. Try again."),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(commands).toEqual([{ type: "retry" }]));

  await waitFor(() =>
    expect(
      view
        .getByRole("button", { name: "Do it for me" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  expect(
    view.getByRole("button", { name: "Guide" }).getAttribute("aria-pressed"),
  ).toBe("true");
});
