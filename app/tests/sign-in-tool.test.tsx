import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * The private sign-in card, drawn by the render the SDK registered ONCE.
 *
 * `useFrontendTool` keeps the first registration's render for as long as the tool's name and
 * availability stay the same, so anything that render read from component state was frozen at first
 * render. The card used to take its request id from such state, never learned it, and never drew
 * "Open private sign-in": nobody could reach the form from the chat and every request expired. This
 * captures the first registration only, exactly as the SDK keeps it, and expects the button anyway.
 */

const real = { ...(await import("@copilotkit/react-core/v2")) };
type Registered = Parameters<typeof real.useFrontendTool>[0];
const registered: Registered[] = [];
mock.module("@copilotkit/react-core/v2", () => ({
  ...real,
  useCopilotKit: () => ({ copilotkit: { stopAgent: () => undefined } }),
  useFrontendTool: (tool: Registered) => {
    if (!registered.some((entry) => entry.name === tool.name))
      registered.push(tool);
  },
}));
const { SignInTool } = await import("@/lib/copilot/sign-in-tool");

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => {
  GlobalRegistrator.unregister();
  mock.module("@copilotkit/react-core/v2", () => real);
});

const request = {
  id: "req-1",
  botId: "default",
  origin: "https://example.com",
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
};

test("the card offers the private form while the request it opened is waiting", async () => {
  let status = "pending";
  const originalFetch = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (url.endsWith("/api/sign-in-requests") && init?.method === "POST")
        return Response.json(request, { status: 201 });
      if (url.includes("/api/sign-in-requests/req-1"))
        return Response.json({ ...request, status });
      return Response.json({}, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
  );
  try {
    render(wrap(<SignInTool />));
    const tool = registered.find(
      (entry) => entry.name === "computer_request_sign_in",
    );
    expect(tool?.render).toBeDefined();
    const Card = tool?.render as (props: Record<string, unknown>) => ReactNode;
    const props = {
      args: { site: "https://example.com" },
      status: "executing",
      toolCallId: "call-1",
      result: undefined,
    };
    const view = render(wrap(<Card {...props} />));
    // Nothing opened yet: no form to offer.
    expect(view.queryByText("Open private sign-in")).toBeNull();

    const controller = new AbortController();
    const answer = tool?.handler?.({ site: "https://example.com" }, {
      signal: controller.signal,
      toolCall: { id: "call-1" },
    } as never);
    // The once-registered render, with nothing re-registered, now shows the way to the form.
    await waitFor(() =>
      expect(view.getByText("Open private sign-in")).toBeDefined(),
    );

    status = "signed_in";
    expect(await answer).toMatchObject({
      ok: true,
      signedIn: true,
      requestId: "req-1",
    });
    // The request is answered: the way to the form goes, and nothing is left to redraw after this.
    await waitFor(() =>
      expect(view.queryByText("Open private sign-in")).toBeNull(),
    );
    view.unmount();
  } finally {
    global.fetch = originalFetch;
  }
});
