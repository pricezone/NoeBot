import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SecretCard } from "@/lib/copilot/computer-tools";
import { settleReactWork } from "./settle-react-work";

/**
 * A secret request is answered in one place: the Secure Form row in the conversation.
 *
 * The screen card used to draw its own password box and an amber "The assistant needs you." bar, so
 * the same request appeared twice, in two designs, with two submit paths. Now the card says what the
 * Bot needs in one muted line and links to the row in the chat, which it opens.
 */

const BOT = "request-view-bot";
let originalFetch: typeof fetch;
let originalIntersectionObserver: unknown;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  originalIntersectionObserver = Reflect.get(window, "IntersectionObserver");
  Reflect.deleteProperty(window, "IntersectionObserver");
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/control"))
      return Response.json({
        holder: "bot",
        since: "2026-10-13T09:00:00Z",
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
        secretWanted: "the code sent to your phone",
      });
    if (path.endsWith("/status"))
      return Response.json({ botId: BOT, state: "ready", browser: "running" });
    if (path.endsWith("/screenshot"))
      return Response.json({
        base64: "AAAA",
        width: 1280,
        height: 800,
        capturedAt: "2026-10-13T09:00:00Z",
        url: "https://example.com/",
      });
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  if (originalIntersectionObserver)
    Reflect.set(window, "IntersectionObserver", originalIntersectionObserver);
  GlobalRegistrator.unregister();
});

test("the screen card no longer draws its own secret form; Answer in the chat opens the row in the conversation", async () => {
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TooltipProvider>
        <ComputerView
          active
          computerId={BOT}
          controls={false}
          intervalMs={10}
          minHeight={0}
          minWidth={0}
        />
        <SecretCard
          computerId={BOT}
          label="the code sent to your phone"
          running
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );

  expect(
    await view.findByText("Your Bot needs the code sent to your phone."),
  ).toBeTruthy();
  // No second password box, no amber bar, no second submit path.
  expect(view.container.querySelector('input[type="password"]')).toBeNull();
  expect(view.queryByText(/The assistant needs/)).toBeNull();
  expect(view.queryByText("Send to the page")).toBeNull();

  fireEvent.click(view.getByRole("button", { name: "Answer in the chat" }));

  // The row's own dialog: one masked field, the lock note, Continue.
  await waitFor(() =>
    expect(document.querySelector('input[type="password"]')).not.toBeNull(),
  );
  expect(
    document.body.textContent?.includes(
      "Never shown to your Bot. Filled directly into the page.",
    ),
  ).toBe(true);
});
