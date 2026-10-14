import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useClickyAttention } from "@/lib/clicky/use-clicky-attention";
import { takeClickyViewerRequest } from "@/lib/clicky/viewer-request";
import { useComputerAttention } from "@/lib/computers/attention";
import { useComputerControl } from "@/lib/computers/use-control";
import { deploymentKeys } from "@/lib/deployment/queries";
import { queryClient } from "@/query-client";
import {
  type ClickyCommand,
  type ClickySession,
  newClickySession,
} from "../../shared/clicky";
import { settleReactWork } from "./settle-react-work";

/**
 * When the Bot needs the person on its computer, Clicky opens by itself for somebody who lets it:
 * the screen is asked to open full-window at once, and after a grace period that leaves the server
 * time to open Clicky itself, the browser only wakes Clicky if it is still asleep (the server alone
 * opens it on the Bot's need, and refuses a browser's `activate` for one). Once per need, however
 * often the control poll says the same thing; a need that clears and comes back is new.
 */

let commands: { botId: string; command: ClickyCommand }[] = [];
let sessions: Record<string, ClickySession> = {};
let preferences: Record<string, unknown> = {};
let need: "help" | "secret" | "none" = "help";
let requestId = "request-1";
const originalFetch = globalThis.fetch;

function session(botId: string, patch: Partial<ClickySession> = {}) {
  return {
    ...newClickySession({ id: `s-${botId}`, botId, now: 0 }),
    ...patch,
  };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Whatever an earlier file left in the shared cache (a signed-out person, say) is not ours.
  queryClient.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (/^\/api\/computers\/[^/]+\/control$/.test(url))
      return Response.json({
        holder: "bot",
        since: "2026-10-14T09:00:00Z",
        requested: need === "help",
        ...(need === "secret"
          ? {
              secretWanted: "One-time code",
              secretRef: "e42",
              secretSnapshotId: 7,
            }
          : {}),
        ...(need === "help"
          ? {
              reason: "Please sign in to the bank.",
              request: {
                id: requestId,
                status: "waiting",
                reason: "Please sign in to the bank.",
                source: "model",
                pointAt: "e7",
                createdAt: "2026-10-14T09:00:00Z",
                updatedAt: "2026-10-14T09:00:00Z",
              },
            }
          : {}),
        transitioning: false,
        resumeSnapshotRequired: false,
      });
    const read = /^\/api\/computers\/([^/]+)\/clicky$/.exec(url);
    if (read?.[1])
      return Response.json({
        session: sessions[read[1]] ?? session(read[1]),
      });
    const sent = /^\/api\/computers\/([^/]+)\/clicky\/commands$/.exec(url);
    if (sent?.[1]) {
      const command = JSON.parse(String(init?.body)) as ClickyCommand;
      commands.push({ botId: sent[1], command });
      return Response.json({
        session: session(sent[1], { awake: true, seq: 2 }),
      });
    }
    if (url === "/api/me")
      return Response.json({ user: { id: "person-1", email: "p@x.test" } });
    if (url === "/api/settings/preferences")
      return Response.json({ preferences });
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  preferences = { messageListEmphasis: "agent" };
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    clicky: { enabled: true, voice: false },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  commands = [];
  sessions = {};
  need = "help";
  requestId = "request-1";
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

let refresh: (() => Promise<void>) | undefined;

/** The whole path: the panel's attention hook, with Clicky's real grace period. */
function Attention({ botId }: { botId: string }) {
  useComputerAttention(botId);
  refresh = useComputerControl(botId).refresh;
  return null;
}

/** Clicky's part alone, with a short grace, for the cases about what happens after it. */
function Quick({ botId, grace = 40 }: { botId: string; grace?: number }) {
  const { control, refresh: read } = useComputerControl(botId);
  refresh = read;
  useClickyAttention(botId, control, grace);
  return null;
}

const settle = (ms = 60) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

test("a pending help request opens the screen at once and, after the grace, wakes Clicky once", async () => {
  const view = render(<Attention botId="attention-1" />);
  await waitFor(() =>
    expect(takeClickyViewerRequest("attention-1")).toBe(true),
  );
  // The server is given its moment first.
  expect(commands).toEqual([]);

  await waitFor(
    () =>
      expect(commands).toEqual([
        {
          botId: "attention-1",
          command: { type: "wake" },
        },
      ]),
    { timeout: 3_000 },
  );

  // The same request, seen again on the next poll and the next render, asks nothing more.
  await act(async () => void (await refresh?.()));
  view.rerender(<Attention botId="attention-1" />);
  await settle();
  expect(commands).toHaveLength(1);
  expect(takeClickyViewerRequest("attention-1")).toBe(false);
});

test("when the server has woken Clicky for this request meanwhile, nothing is sent", async () => {
  sessions["attention-2"] = session("attention-2", {
    awake: true,
    state: "thinking",
    trigger: { kind: "takeover", requestId: "request-1" },
    seq: 4,
  });
  render(<Quick botId="attention-2" />);
  await waitFor(() =>
    expect(takeClickyViewerRequest("attention-2")).toBe(true),
  );
  await settle(150);
  expect(commands).toEqual([]);
});

test("a secret wakes Clicky too, and a session already awake is left to the server", async () => {
  need = "secret";
  render(<Quick botId="attention-3" />);
  await waitFor(() =>
    expect(commands).toEqual([
      { botId: "attention-3", command: { type: "wake" } },
    ]),
  );
  sessions["attention-3b"] = session("attention-3b", {
    awake: true,
    state: "guiding",
    seq: 2,
  });
  render(<Quick botId="attention-3b" />);
  await settle(150);
  expect(commands.filter(({ botId }) => botId === "attention-3b")).toEqual([]);
  takeClickyViewerRequest("attention-3b");
});

test("a need that clears within the grace sends nothing; one that comes back is new", async () => {
  render(<Quick botId="attention-4" grace={400} />);
  await waitFor(() =>
    expect(takeClickyViewerRequest("attention-4")).toBe(true),
  );
  // Answered before the grace ran out.
  need = "none";
  await act(async () => void (await refresh?.()));
  await settle(500);
  expect(commands).toEqual([]);

  // The Bot asks again: a new request, handled as one.
  need = "help";
  requestId = "request-2";
  await act(async () => void (await refresh?.()));
  await waitFor(
    () =>
      expect(commands.map(({ command }) => command)).toEqual([
        { type: "wake" },
      ]),
    { timeout: 2_000 },
  );
  expect(takeClickyViewerRequest("attention-4")).toBe(true);
});

test("somebody who turned auto-open off is left alone", async () => {
  preferences = { messageListEmphasis: "agent", clickyAutoActivate: false };
  render(<Quick botId="attention-5" />);
  await settle(150);
  expect(commands).toEqual([]);
  expect(takeClickyViewerRequest("attention-5")).toBe(false);
});

test("nothing happens on a deployment without Clicky", async () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
  });
  render(<Quick botId="attention-6" />);
  await settle(150);
  expect(commands).toEqual([]);
  expect(takeClickyViewerRequest("attention-6")).toBe(false);
});
