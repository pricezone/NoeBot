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
 * the screen is asked to open full-window, and if the server has not already woken Clicky for this
 * request, the browser sends one `activate` with the request's own id. Once per request, however
 * often the control poll says the same thing.
 */

let commands: { botId: string; command: ClickyCommand }[] = [];
let sessions: Record<string, ClickySession> = {};
let preferences: Record<string, unknown> = {};
let secret = false;
const originalFetch = globalThis.fetch;

function session(botId: string, patch: Partial<ClickySession> = {}) {
  return { ...newClickySession({ id: `s-${botId}`, botId, now: 0 }), ...patch };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Whatever an earlier file left in the shared cache (a signed-out person, say) is not ours.
  queryClient.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const control = /^\/api\/computers\/([^/]+)\/control$/.exec(url);
    if (control)
      return Response.json({
        holder: "bot",
        since: "2026-10-14T09:00:00Z",
        requested: !secret,
        ...(secret
          ? { secretWanted: "One-time code", secretRef: "e42" }
          : {
              reason: "Please sign in to the bank.",
              request: {
                id: "request-1",
                status: "waiting",
                reason: "Please sign in to the bank.",
                source: "model",
                createdAt: "2026-10-14T09:00:00Z",
                updatedAt: "2026-10-14T09:00:00Z",
              },
            }),
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
  secret = false;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

let refresh: (() => Promise<void>) | undefined;
function Probe({ botId }: { botId: string }) {
  useComputerAttention(botId);
  refresh = useComputerControl(botId).refresh;
  return null;
}

const settle = (ms = 60) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

test("a pending help request opens the screen and activates Clicky once, with the request's id", async () => {
  const view = render(<Probe botId="attention-1" />);
  await waitFor(() =>
    expect(commands).toEqual([
      {
        botId: "attention-1",
        command: {
          type: "activate",
          trigger: {
            kind: "takeover",
            requestId: "request-1",
            reason: "Please sign in to the bank.",
          },
        },
      },
    ]),
  );
  expect(takeClickyViewerRequest("attention-1")).toBe(true);

  // The same request, seen again on the next poll and the next render, asks nothing more.
  await act(async () => void (await refresh?.()));
  view.rerender(<Probe botId="attention-1" />);
  await settle();
  expect(commands).toHaveLength(1);
  expect(takeClickyViewerRequest("attention-1")).toBe(false);
});

test("when the server has already woken Clicky for this request, nothing is sent", async () => {
  sessions["attention-2"] = session("attention-2", {
    awake: true,
    state: "thinking",
    trigger: { kind: "takeover", requestId: "request-1" },
    seq: 4,
  });
  render(<Probe botId="attention-2" />);
  await waitFor(() =>
    expect(takeClickyViewerRequest("attention-2")).toBe(true),
  );
  await settle();
  expect(commands).toEqual([]);
});

test("a secret wanted points Clicky at its field", async () => {
  secret = true;
  render(<Probe botId="attention-3" />);
  await waitFor(() =>
    expect(commands).toEqual([
      {
        botId: "attention-3",
        command: {
          type: "activate",
          trigger: { kind: "secret", targetRef: "e42" },
        },
      },
    ]),
  );
});

test("somebody who turned auto-open off is left alone", async () => {
  preferences = { messageListEmphasis: "agent", clickyAutoActivate: false };
  render(<Probe botId="attention-4" />);
  await settle(150);
  expect(commands).toEqual([]);
  expect(takeClickyViewerRequest("attention-4")).toBe(false);
});

test("nothing happens on a deployment without Clicky", async () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
  });
  render(<Probe botId="attention-5" />);
  await settle(150);
  expect(commands).toEqual([]);
  expect(takeClickyViewerRequest("attention-5")).toBe(false);
});
