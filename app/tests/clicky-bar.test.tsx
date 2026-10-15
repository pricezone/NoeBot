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
import { clickyKeys } from "@/lib/clicky/queries";
import { resetClickyStopFailures } from "@/lib/clicky/stop";
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
 * than a quarter of a second, a release while the microphone is still opening, and a cancelled
 * pointer ask nothing. Stop is always there and never waits behind another command; a Stop that
 * cannot get through says so. Next and Back move through a walkthrough; a refused command says why
 * in Clicky's own words; "Do it for me" is not offered where Clicky may not act.
 */

const BOT = "bar-bot";
let commands: ClickyCommand[] = [];
let transcriptions = 0;
let rejectNext: string | null = null;
let failStops = 0;
/** A command that, when it is this one, waits for `release()` before it is answered. */
let gate: { type: string; open: Promise<void>; release: () => void } | null =
  null;
let preferences: Record<string, unknown> = {};
let preferencesHang = false;
/** What the server answers every command with: the session as the test drew it. */
let drawn: ClickySession;
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

function gateNext(type: string) {
  let release = () => {};
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate = { type, open, release };
  return gate;
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
      if (command.type === "stop" && failStops > 0) {
        failStops -= 1;
        return Response.json({ error: "Unavailable" }, { status: 503 });
      }
      if (gate && gate.type === command.type) await gate.open;
      const rejected = rejectNext;
      rejectNext = null;
      return Response.json({
        session: drawn,
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
    if (url === "/api/settings/preferences") {
      if (preferencesHang) await new Promise(() => {});
      return Response.json({ preferences });
    }
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
  gate?.release();
  cleanup();
  queryClient.clear();
  resetClickyStopFailures();
  commands = [];
  transcriptions = 0;
  rejectNext = null;
  failStops = 0;
  gate = null;
  preferencesHang = false;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.MediaRecorder = originalMediaRecorder;
  GlobalRegistrator.unregister();
});

/** The bar reads the session the viewer keeps in the cache; the test puts it there. */
function draw(session: ClickySession = sessionAt(1)) {
  drawn = session;
  queryClient.setQueryData(clickyKeys.session(BOT), session);
  return render(
    <TooltipProvider>
      <ClickyBar botId={BOT} />
    </TooltipProvider>,
  );
}

const hold = (ms: number) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** Once the person's settings are in, so what depends on them is drawn. */
const settingsIn = () =>
  waitFor(() =>
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["settings", "preferences"] })
        .some((query) => query.state.data !== undefined),
    ).toBe(true),
  );

test("holding the microphone listens, and letting go transcribes, stops listening and asks", async () => {
  const view = draw();
  const mic = view.getByRole("button", { name: "Hold to talk" });

  fireEvent.pointerDown(mic, { pointerId: 1 });
  await waitFor(() =>
    expect(commands).toEqual([{ type: "listen", active: true }]),
  );
  await waitFor(() =>
    expect(
      mic.closest("button")?.getAttribute("data-clicky") === "hold-to-talk" &&
        view.getByRole("button", { name: "Release to send" }),
    ).toBeTruthy(),
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

test("a held press the system cancels asks nothing, however long it was held", async () => {
  const view = draw();
  const mic = view.getByRole("button", { name: "Hold to talk" });

  fireEvent.pointerDown(mic, { pointerId: 1 });
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Release to send" })).toBeTruthy(),
  );
  await hold(300);
  fireEvent.pointerCancel(mic, { pointerId: 1 });

  await waitFor(() =>
    expect(commands).toEqual([
      { type: "listen", active: true },
      { type: "listen", active: false },
    ]),
  );
  await hold(50);
  expect(transcriptions).toBe(0);
});

test("no microphone where the deployment cannot listen", () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    clicky: { enabled: true, voice: false },
  });
  const view = draw();
  expect(view.queryByRole("button", { name: "Hold to talk" })).toBeNull();
  expect(
    view.getByRole("textbox", { name: "Ask about the screen" }),
  ).toBeTruthy();
});

test("Stop sends stop, and a typed question is asked", async () => {
  const view = draw(sessionAt(1, { state: "acting" }));
  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(commands).toEqual([{ type: "stop" }]));

  const box = view.getByRole("textbox", { name: "Ask about the screen" });
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

test("Stop does not wait behind a slow command, and what was still queued is dropped", async () => {
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
  const slow = gateNext("pause");
  fireEvent.click(view.getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(commands).toEqual([{ type: "pause" }]));
  // Queued behind the pause that has not been answered.
  fireEvent.click(view.getByRole("button", { name: "Next" }));

  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(commands).toEqual([{ type: "pause" }, { type: "stop" }]),
  );

  slow.release();
  await hold(50);
  expect(commands).toEqual([{ type: "pause" }, { type: "stop" }]);
});

test("a Stop that cannot get through is tried again, then said, with a way to try again", async () => {
  const view = draw(sessionAt(1, { state: "acting" }));
  failStops = 2;
  fireEvent.click(view.getByRole("button", { name: "Stop" }));

  const said = await view.findByText(
    "Couldn't stop. Try again.",
    {},
    { timeout: 2_000 },
  );
  expect(said.closest('[role="alert"]')).toBeTruthy();
  expect(commands).toEqual([{ type: "stop" }, { type: "stop" }]);

  fireEvent.click(view.getByRole("button", { name: "Try again" }));
  // The answer settles outside any React event; give it a moment inside `act`.
  await hold(100);
  expect(view.queryByText("Couldn't stop. Try again.")).toBeNull();
  expect(commands).toHaveLength(3);
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

test("a long reply can be read whole", async () => {
  const long =
    "Open the menu at the top right, choose Account, then Security, then scroll to the bottom of the page where the two-step settings are, and press Change.";
  const view = draw(sessionAt(1, { reply: { text: long, final: true } }));
  const more = view.getByRole("button", { name: "Show more" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(view.getByText(long).getAttribute("title")).toBe(long);
  fireEvent.click(more);
  expect(
    view
      .getByRole("button", { name: "Show less" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("the reply shows Clicky's line and a failed look offers Retry", async () => {
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
});

test("Guide and Do it for me are offered once the settings say Clicky may act", async () => {
  const view = draw();
  const act = await view.findByRole("button", { name: "Do it for me" });
  expect(
    view.getByRole("button", { name: "Guide" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(act);
  await waitFor(() =>
    expect(commands).toEqual([{ type: "set_mode", mode: "act" }]),
  );
});

test("for somebody who set guide only, there is no Do it for me at all", async () => {
  preferences = {
    messageListEmphasis: "agent",
    clickyOnboarded: true,
    clickyActionPolicy: "never",
  };
  const view = draw();
  await settingsIn();
  await hold(20);
  expect(view.queryByRole("button", { name: "Do it for me" })).toBeNull();
  expect(view.queryByRole("button", { name: "Guide" })).toBeNull();
});

test("for a sign-in, a secret or a challenge, there is no Do it for me", async () => {
  for (const kind of ["sign_in", "secret", "challenge"] as const) {
    const view = draw(
      sessionAt(1, {
        state: "guiding",
        trigger: { kind, requestId: `${kind}-1` },
      }),
    );
    await settingsIn();
    await hold(20);
    expect(view.queryByRole("button", { name: "Do it for me" })).toBeNull();
    view.unmount();
  }
});

test("acting when a sign-in arrives, the way back to Guide stays", async () => {
  const view = draw(
    sessionAt(1, {
      state: "guiding",
      mode: "act",
      trigger: { kind: "sign_in", requestId: "s-1" },
    }),
  );
  await settingsIn();
  const guide = await view.findByRole("button", { name: "Guide" });
  expect(view.queryByRole("button", { name: "Do it for me" })).toBeNull();
  fireEvent.click(guide);
  await waitFor(() =>
    expect(commands).toEqual([{ type: "set_mode", mode: "guide" }]),
  );
});

test("before the settings have arrived, Do it for me is not shown even for a moment", async () => {
  preferencesHang = true;
  const view = draw();
  await hold(50);
  expect(view.queryByRole("button", { name: "Do it for me" })).toBeNull();
  expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("the bar and its menu are marked as this page's own controls", async () => {
  const view = draw(sessionAt(1, { reply: { text: "Hi", final: true } }));
  expect(
    view.container.querySelector("[data-clicky-bar][data-clicky-ui]"),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "More options" }));
  const menu = await view.findByRole("menu");
  expect(menu.closest("[data-clicky-ui]")).toBeTruthy();
  // Portalled: outside the bar itself.
  expect(menu.closest("[data-clicky-bar]")).toBeNull();
});
