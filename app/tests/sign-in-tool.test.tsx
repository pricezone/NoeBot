import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
const { ConversationProvider } = await import("@/lib/copilot/conversation");

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
    // Nothing opened yet: no form to offer, the row says it is being prepared.
    expect(view.queryByRole("button", { name: "Open" })).toBeNull();
    expect(view.getByText("Preparing…")).toBeDefined();

    const controller = new AbortController();
    const answer = tool?.handler?.({ site: "https://example.com" }, {
      signal: controller.signal,
      toolCall: { id: "call-1" },
    } as never);
    // The once-registered render, with nothing re-registered, now shows the way to the form: the
    // secure form row, titled for the site, with its Open pill.
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Open" })).toBeDefined(),
    );
    expect(view.getByText("Sign in to example.com")).toBeDefined();
    expect(view.getByText("Secure Form")).toBeDefined();

    status = "signed_in";
    expect(await answer).toMatchObject({
      ok: true,
      signedIn: true,
      requestId: "req-1",
    });
    // The request is answered: the way to the form goes, and nothing is left to redraw after this.
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "Open" })).toBeNull(),
    );
    view.unmount();
  } finally {
    global.fetch = originalFetch;
  }
});

test("a tab that did not run the call still offers the form, found by the call's id", async () => {
  const originalFetch = global.fetch;
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      const url = String(path);
      if (url.endsWith("/api/sign-in-requests"))
        return Response.json({
          requests: [
            { ...request, id: "other", toolCallId: "call-other" },
            {
              ...request,
              id: "req-2",
              toolCallId: "call-2",
              origin: "https://oauth2.gsis.gr",
              title: "Σύνδεση Taxisnet",
            },
          ],
        });
      if (url.includes("/api/sign-in-requests/req-2"))
        return Response.json({
          ...request,
          id: "req-2",
          toolCallId: "call-2",
          origin: "https://oauth2.gsis.gr",
          title: "Σύνδεση Taxisnet",
        });
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
    const Card = tool?.render as (props: Record<string, unknown>) => ReactNode;
    // Another tab: the call is running, but this tab never ran its handler.
    const view = render(
      wrap(
        <Card
          args={{ site: "https://www.gov.gr" }}
          result={undefined}
          status="executing"
          toolCallId="call-2"
        />,
      ),
    );
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Open" })).toBeDefined(),
    );
    expect(view.getByText("Σύνδεση Taxisnet")).toBeDefined();
    view.unmount();
  } finally {
    global.fetch = originalFetch;
  }
});

/** The registered card, drawn inside a conversation whose `ask` is recorded. */
function drawCard(props: Record<string, unknown>) {
  const asked: string[] = [];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SignInTool />
    </QueryClientProvider>,
  );
  const tool = registered.find(
    (entry) => entry.name === "computer_request_sign_in",
  );
  const Card = tool?.render as (props: Record<string, unknown>) => ReactNode;
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationProvider ask={(text) => void asked.push(text)}>
        <Card {...props} />
      </ConversationProvider>
    </QueryClientProvider>,
  );
  return { view, asked };
}

test("a finished row speaks to the person, never in the Bot's words, and Ask again asks as them", async () => {
  const originalFetch = global.fetch;
  global.fetch = Object.assign(async () => Response.json({}, { status: 404 }), {
    preconnect: originalFetch.preconnect,
  });
  try {
    const { view, asked } = drawCard({
      args: { site: "https://example.com" },
      status: "complete",
      toolCallId: "call-3",
      result: JSON.stringify({
        ok: false,
        site: "https://example.com",
        status: "cancelled",
        outcome: "error",
        pageMessage: "Incorrect password",
        result:
          "The person chose not to sign in to https://example.com. Do not ask for the login another way.",
      }),
    });
    expect(view.getByText("Cancelled")).toBeDefined();
    expect(
      view.getByText(
        "Wrong password or code. The site says: “Incorrect password” The sign-in was then declined.",
      ),
    ).toBeDefined();
    expect(view.queryByText(/Do not ask for the login/)).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Ask again" }));
    expect(asked).toEqual(["Ask me again for the sign-in to example.com"]);
    view.unmount();
  } finally {
    global.fetch = originalFetch;
  }
});

test("an expired row says so and offers Ask again; a signed-in one offers nothing more", async () => {
  const originalFetch = global.fetch;
  global.fetch = Object.assign(async () => Response.json({}, { status: 404 }), {
    preconnect: originalFetch.preconnect,
  });
  try {
    const expired = drawCard({
      args: { site: "https://example.com" },
      status: "complete",
      toolCallId: "call-4",
      result: JSON.stringify({
        ok: false,
        status: "expired",
        result: "Nobody signed in. Do not ask for the login another way.",
      }),
    });
    expect(expired.view.getByText("Expired")).toBeDefined();
    expect(
      expired.view.getByText(
        "This sign-in request expired before anyone signed in.",
      ),
    ).toBeDefined();
    expect(
      expired.view.getByRole("button", { name: "Ask again" }),
    ).toBeDefined();
    expired.view.unmount();
    const done = drawCard({
      args: { site: "https://example.com" },
      status: "complete",
      toolCallId: "call-5",
      result: JSON.stringify({ ok: true, signedIn: true, status: "signed_in" }),
    });
    expect(done.view.getByText("Submitted")).toBeDefined();
    expect(done.view.queryByRole("button", { name: "Ask again" })).toBeNull();
    done.view.unmount();
  } finally {
    global.fetch = originalFetch;
  }
});

test("while the site waits for the person's phone, the row says so and Continue asks the server to look", async () => {
  const originalFetch = global.fetch;
  const posted: string[] = [];
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (init?.method === "POST") posted.push(url);
      if (url.includes("/api/sign-in-requests/req-6"))
        return Response.json({
          ...request,
          id: "req-6",
          status: "filling",
          approvalUntil: new Date(Date.now() + 60_000).toISOString(),
          attempt: { outcome: "push-approval" },
        });
      return Response.json({}, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const { view } = drawCard({
      args: { site: "https://example.com" },
      status: "executing",
      toolCallId: "call-6",
      result: JSON.stringify({ requestId: "req-6" }),
    });
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Continue" })).toBeDefined(),
    );
    expect(view.getByText(/Waiting for approval on your phone/)).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(posted.some((url) => url.endsWith("/req-6/continue"))).toBe(true),
    );
    view.unmount();
  } finally {
    global.fetch = originalFetch;
  }
});
