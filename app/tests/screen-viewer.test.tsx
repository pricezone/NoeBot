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
import userEvent from "@testing-library/user-event";
import { ComputerView } from "@/components/computer/computer-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { agentKeys } from "@/lib/agents/queries";
import { brand } from "@/lib/brand";
import { useComputerControl } from "@/lib/computers/use-control";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * The Bot's screen, near full-window.
 *
 * Opened from the preview card. Whose screen it is sits top-left; Take control (with what teaching
 * a workflow means), Record your steps and Minimize sit top-right. Minimize and Escape close it,
 * and Escape inside "Name this workflow" belongs to that dialog, not to the viewer behind it.
 *
 * While the person holds control there is no Hand back: minimizing hands control back, unless they
 * switched on Keep control, in which case it only closes the viewer.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

const BOT = "viewer-bot";
let holder: "bot" | "human" = "bot";
let requested = false;
let recordings: { id: string; status: string; steps: number }[] = [];
/** Every change of control the viewer asked for, in order: take, release, cancel. */
let controlChanges: { path: string; body: unknown }[] = [];
let failRelease = false;
const originalFetch = globalThis.fetch;
let originalWebSocket: typeof WebSocket;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/control/") && !url.endsWith("/control/request"))
      controlChanges.push({
        path: url.slice(url.lastIndexOf("/") + 1),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
    if (url.endsWith("/control/release") && failRelease)
      return Response.json({ error: "Unavailable" }, { status: 503 });
    if (url.endsWith("/control/take")) holder = "human";
    if (url.endsWith("/control/release")) holder = "bot";
    if (url.includes("/control"))
      return Response.json({
        holder,
        since: "2026-10-07T09:00:00Z",
        requested,
        ...(requested ? { reason: "Please sign in to the bank." } : {}),
        transitioning: false,
        resumeSnapshotRequired: false,
        request: {
          id: "request-1",
          status: holder === "human" ? "taken" : "waiting",
          reason: "Please sign in to the bank.",
          source: "model",
          createdAt: "2026-10-07T09:00:00Z",
          updatedAt: "2026-10-07T09:00:00Z",
        },
      });
    if (url === "/api/demonstrations/d1/stop") {
      for (const recording of recordings) recording.status = "stopped";
      return Response.json({ demonstration: {} });
    }
    if (url.startsWith("/api/demonstrations?"))
      return Response.json({
        demonstrations: recordings.map((recording) => ({
          id: recording.id,
          botId: BOT,
          title: "Untitled workflow",
          status: recording.status,
          actions: Array.from({ length: recording.steps }, () => ({
            kind: "click",
            target: { role: "button", name: "Search", sensitive: false },
          })),
          draft: null,
          skillSlug: null,
          createdAt: new Date().toISOString(),
          finishedAt: null,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          maxDurationMs: 600_000,
          reachedTimeLimit: false,
        })),
      });
    void init;
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  holder = "bot";
  requested = false;
  recordings = [];
  controlChanges = [];
  failRelease = false;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

/** The bot panel's preview card, the way `ComputerTab` draws it. */
function preview() {
  queryClient.setQueryData(agentKeys.detail(BOT), {
    avatarSeed: "noe-seed",
    builtIn: true,
    canManage: true,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    id: BOT,
    mine: true,
    name: "Noë",
    pinned: false,
    roleDescription: "Helps with everything.",
    systemOwned: false,
    title: "",
    visibility: "private",
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ComputerView
          active
          caption="Noë's screen"
          computerId={BOT}
          controls={false}
          minHeight={0}
          minWidth={0}
          name="Noë"
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { view, user };
}

async function open(view: ReturnType<typeof render>) {
  fireEvent.click(
    view.getByRole("button", { name: "Open the assistant's screen full size" }),
  );
  const element = await view.findByRole("dialog", {
    name: "The assistant's screen",
  });
  return { element, viewer: within(element) };
}

/**
 * By its attributes, not by role: a modal dialog over the viewer hides it from the accessibility
 * tree meanwhile, and a hidden element has no accessible name to be found by.
 */
const viewerOpen = (view: ReturnType<typeof render>) =>
  view.baseElement.querySelector(
    '[role="dialog"][aria-label="The assistant\'s screen"]',
  ) !== null;

test("the preview card has no wheel; the viewer has the Bot top-left and the controls top-right", async () => {
  const { view } = preview();
  expect(view.getByText("Noë's screen")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Take control" })).toBeNull();
  expect(view.queryByText("The assistant has control.")).toBeNull();

  const { element, viewer } = await open(view);
  expect(element.getAttribute("aria-modal")).toBe("true");
  const header = element.querySelector("header") as HTMLElement;
  expect(within(header).getByText("Noë")).toBeTruthy();
  // The Bot's own face: its avatar seed, not its id.
  const avatar = header.querySelector("span[aria-hidden='true']");
  const own = render(<brand.Avatar seed="noe-seed" size={28} />).container;
  const byId = render(<brand.Avatar seed={BOT} size={28} />).container;
  expect(avatar?.outerHTML).toBe(own.innerHTML);
  expect(own.innerHTML).not.toBe(byId.innerHTML);
  expect(
    await within(header).findByRole("button", { name: "Take control" }),
  ).toBeTruthy();
  expect(
    within(header).getByRole("button", { name: "Record your steps" }),
  ).toBeTruthy();
  expect(
    within(header).getByRole("button", { name: "Minimize screen" }),
  ).toBeTruthy();
  // Still exactly one wheel on the page.
  expect(view.getAllByRole("button", { name: "Take control" })).toHaveLength(1);
  expect(viewer.getByText(/You cannot see the screen right now/)).toBeTruthy();
});

test("hovering Take control in the viewer explains teaching a browser workflow", async () => {
  const { view, user } = preview();
  const { viewer } = await open(view);
  const take = await viewer.findByRole("button", { name: "Take control" });
  await waitFor(() => expect(take.hasAttribute("disabled")).toBe(false));

  await user.hover(take);

  expect(await view.findByText("Teach a browser workflow")).toBeTruthy();
  expect(
    view.getByText(
      "Take control, record the steps, then review a skill draft. Typed values and images are omitted. Sensitive fields stay in your hands. Recording stops automatically after ten minutes.",
    ),
  ).toBeTruthy();
});

test("Minimize closes the viewer and the backdrop does not", async () => {
  const { view } = preview();
  const { element, viewer } = await open(view);

  fireEvent.click(element);
  expect(viewerOpen(view)).toBe(true);

  fireEvent.click(viewer.getByRole("button", { name: "Minimize screen" }));
  await waitFor(() => expect(viewerOpen(view)).toBe(false));
  // The card it came from is still there to open it again.
  expect(
    view.getByRole("button", { name: "Open the assistant's screen full size" }),
  ).toBeTruthy();
});

test("Escape minimizes, but not while Name this workflow is open over it", async () => {
  holder = "human";
  recordings = [{ id: "d1", status: "recording", steps: 2 }];
  const { view, user } = preview();
  const { viewer } = await open(view);
  expect(await viewer.findByRole("status")).toBeTruthy();
  expect(viewer.getByRole("status").textContent).toContain("You have control");

  await user.click(
    await viewer.findByRole("button", { name: "Stop recording" }),
  );
  const name = await view.findByLabelText("Workflow name");
  // An Escape that reaches the window while the dialog is open is not the viewer's.
  fireEvent.keyDown(window, { key: "Escape" });
  expect(viewerOpen(view)).toBe(true);
  expect(view.getByLabelText("Workflow name")).toBe(name);

  await user.click(name);
  await user.keyboard("{Escape}");

  // The dialog took the Escape; the screen stays open behind where it was.
  await waitFor(() =>
    expect(view.queryByLabelText("Workflow name")).toBeNull(),
  );
  expect(viewerOpen(view)).toBe(true);

  await user.keyboard("{Escape}");
  await waitFor(() => expect(viewerOpen(view)).toBe(false));
});

test("when the Bot asks for help, the card says so and Open screen opens the viewer", async () => {
  requested = true;
  const { view } = preview();
  expect(await view.findByText("The assistant needs you.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Cancel request" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Take control" })).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Open screen" }));

  const { viewer } = await (async () => {
    const element = await view.findByRole("dialog", {
      name: "The assistant's screen",
    });
    return { viewer: within(element) };
  })();
  expect(viewer.getByRole("status").textContent).toBe(
    "The assistant needs you. Please sign in to the bank.",
  );
  expect(
    await viewer.findByRole("button", { name: "Take control" }),
  ).toBeTruthy();
});

/**
 * Asks the shared control store to read the server now, rather than waiting out its two-second
 * poll: how a change made somewhere else — another tab, the Bot's own computer — reaches the viewer.
 */
function controlProbe() {
  let refresh: (() => Promise<void>) | undefined;
  function Probe() {
    refresh = useComputerControl(BOT).refresh;
    return null;
  }
  render(<Probe />);
  return () => act(async () => void (await refresh?.()));
}

/** The viewer's control button once the store has read who holds control, and can be pressed. */
async function readyButton(
  viewer: ReturnType<typeof within>,
  name: "Take control" | "Keep control",
) {
  const button = await viewer.findByRole("button", { name });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  return button;
}

const releases = () =>
  controlChanges.filter((change) => change.path === "release");

test("holding control, the viewer offers Keep control, off, and no Hand back", async () => {
  holder = "human";
  const { view } = preview();
  const { viewer } = await open(view);

  const keep = await readyButton(viewer, "Keep control");
  expect(keep.getAttribute("aria-pressed")).toBe("false");
  expect(view.queryByRole("button", { name: "Hand back" })).toBeNull();
  expect(view.queryByRole("button", { name: "Take control" })).toBeNull();
});

test("Minimize with Keep control off hands control back once and closes", async () => {
  holder = "human";
  const { view } = preview();
  const { viewer } = await open(view);
  await readyButton(viewer, "Keep control");

  fireEvent.click(viewer.getByRole("button", { name: "Minimize screen" }));

  await waitFor(() => expect(viewerOpen(view)).toBe(false));
  expect(releases()).toEqual([
    { path: "release", body: { requestId: "request-1" } },
  ]);
});

test("Escape with Keep control off hands control back once and closes", async () => {
  holder = "human";
  const { view } = preview();
  const { viewer } = await open(view);
  await readyButton(viewer, "Keep control");

  fireEvent.keyDown(window, { key: "Escape" });

  await waitFor(() => expect(viewerOpen(view)).toBe(false));
  expect(releases()).toHaveLength(1);
});

test("with Keep control on, Minimize only closes; handing back is reopen, switch off, minimize", async () => {
  holder = "human";
  const { view, user } = preview();
  const { viewer } = await open(view);

  await user.click(await readyButton(viewer, "Keep control"));
  expect(
    viewer
      .getByRole("button", { name: "Keep control" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(viewer.getByRole("button", { name: "Minimize screen" }));

  await waitFor(() => expect(viewerOpen(view)).toBe(false));
  expect(releases()).toHaveLength(0);
  // Still theirs, and the card says so.
  expect(view.getByText("You have control")).toBeTruthy();

  // Reopened, it is still on: the choice belongs to this hold, not to one opening of the viewer.
  const reopened = await open(view);
  const keep = await readyButton(reopened.viewer, "Keep control");
  expect(keep.getAttribute("aria-pressed")).toBe("true");
  await user.click(keep);
  expect(keep.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(
    reopened.viewer.getByRole("button", { name: "Minimize screen" }),
  );

  await waitFor(() => expect(viewerOpen(view)).toBe(false));
  expect(releases()).toHaveLength(1);
});

test("Keep control starts off again once control has gone back to the Bot", async () => {
  holder = "human";
  const refresh = controlProbe();
  const { view, user } = preview();
  const { viewer } = await open(view);
  await user.click(await readyButton(viewer, "Keep control"));
  fireEvent.click(viewer.getByRole("button", { name: "Minimize screen" }));
  await waitFor(() => expect(viewerOpen(view)).toBe(false));

  // Control returns to the Bot from somewhere other than this viewer.
  holder = "bot";
  await refresh();
  await waitFor(() => expect(view.queryByText("You have control")).toBeNull());

  // A new take starts a new hold, with Keep control off.
  const reopened = await open(view);
  await user.click(await readyButton(reopened.viewer, "Take control"));
  const keep = await readyButton(reopened.viewer, "Keep control");
  expect(keep.getAttribute("aria-pressed")).toBe("false");
  expect(releases()).toHaveLength(0);
});

test("minimizing while the Bot holds control, or only asks for it, never hands anything back", async () => {
  const { view } = preview();
  const { viewer } = await open(view);
  await readyButton(viewer, "Take control");
  fireEvent.click(viewer.getByRole("button", { name: "Minimize screen" }));
  await waitFor(() => expect(viewerOpen(view)).toBe(false));

  requested = true;
  const reopened = await open(view);
  await readyButton(reopened.viewer, "Take control");
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(viewerOpen(view)).toBe(false));

  expect(controlChanges).toEqual([]);
});

test("a hand-back that fails keeps the viewer open and says why", async () => {
  holder = "human";
  failRelease = true;
  const { view } = preview();
  const { viewer } = await open(view);
  await readyButton(viewer, "Keep control");

  fireEvent.click(viewer.getByRole("button", { name: "Minimize screen" }));

  expect((await viewer.findByRole("alert")).textContent).toBe(
    "Control could not be changed. Check the connection and retry.",
  );
  expect(viewerOpen(view)).toBe(true);
  expect(releases()).toHaveLength(1);
});
