import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { PendingRequests } from "@/components/chat-cards/pending-requests";
import { settleReactWork } from "./settle-react-work";

/*
 * The Secure Form a person is waiting for must appear in their own tab even when that tab could not
 * load the conversation's history (the conversation service answered 404 while another tab's run was
 * in flight, and the history was "temporarily unavailable"). The request is the server's, so it is
 * drawn from there, and only when the transcript is not already drawing it.
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const request = {
  id: "req-9",
  botId: "assistant",
  origin: "https://oauth2.gsis.gr",
  reason: null,
  status: "pending",
  method: null,
  outcome: null,
  controlRequestId: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  resolvedAt: null,
  passwordManager: false,
  savedLogins: [],
  toolCallId: "call-9",
  title: "Σύνδεση Taxisnet",
  form: "login",
};

function serve() {
  const original = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      if (url.endsWith("/api/sign-in-requests"))
        return Response.json({
          requests: [
            request,
            { ...request, id: "other-bot", botId: "research-desk" },
          ],
        });
      if (url.includes("/api/sign-in-requests/req-9"))
        return Response.json(request);
      if (url.includes("/control"))
        return Response.json({
          holder: "bot",
          since: new Date().toISOString(),
          requested: false,
          transitioning: false,
          resumeSnapshotRequired: false,
        });
      return Response.json({}, { status: 404 });
    },
    { preconnect: original.preconnect },
  );
  return () => {
    global.fetch = original;
  };
}

const wrap = (node: ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
);

test("a tab with no history still offers the Bot's open sign-in, and only that Bot's", async () => {
  const restore = serve();
  try {
    const view = render(
      wrap(
        <PendingRequests
          botId="assistant"
          shown={{ ids: new Set(), unanswered: new Set() }}
        />,
      ),
    );
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Open" })).toBeDefined(),
    );
    expect(view.getByText("Σύνδεση Taxisnet")).toBeDefined();
    expect(view.getAllByRole("button", { name: "Open" })).toHaveLength(1);
  } finally {
    restore();
  }
});

test("a sign-in the transcript already draws, live and open, is not drawn again", async () => {
  const restore = serve();
  try {
    const view = render(
      wrap(
        <PendingRequests
          botId="assistant"
          live={{
            ids: new Set(["call-9"]),
            open: new Map([
              ["call-9", { name: "computer_request_sign_in", args: {} }],
            ]),
            questions: new Set(),
          }}
          shown={{
            ids: new Set(["call-9"]),
            unanswered: new Set(["computer_request_sign_in"]),
          }}
        />,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(view.queryByRole("button", { name: "Open" })).toBeNull();
  } finally {
    restore();
  }
});

test("a sign-in whose call this tab merely holds, answered, is still offered while the server waits", async () => {
  const restore = serve();
  try {
    const view = render(
      wrap(
        <PendingRequests
          botId="assistant"
          live={{
            ids: new Set(["call-9"]),
            open: new Map(),
            questions: new Set(),
          }}
          shown={{ ids: new Set(["call-9"]), unanswered: new Set() }}
        />,
      ),
    );
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Open" })).toBeDefined(),
    );
  } finally {
    restore();
  }
});
