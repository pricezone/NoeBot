import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ClickyOnboarding } from "@/components/clicky/clicky-onboarding";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Clicky's introduction: three short cards the first time, and never again once seen. Finishing
 * (or skipping) saves `clickyOnboarded`, so it stays seen on every device.
 */

let preferences: Record<string, unknown> = {};
let patches: Record<string, unknown>[] = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Whatever an earlier file left in the shared cache (a signed-out person, say) is not ours.
  queryClient.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/me")
      return Response.json({ user: { id: "person-1", email: "p@x.test" } });
    if (url === "/api/settings/preferences") {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push(patch);
        preferences = { ...preferences, ...patch };
      }
      return Response.json({ preferences });
    }
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  patches = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

test("the first time: three cards, then it is saved as seen and not shown again", async () => {
  preferences = { messageListEmphasis: "agent" };
  const view = render(<ClickyOnboarding />);

  expect(await view.findByText("Meet Clicky")).toBeTruthy();
  expect(view.getByText("1 of 3")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  expect(view.getByText("Guide, or Do it for me")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  expect(view.getByText("Stop anytime")).toBeTruthy();
  // The last card teaches the shortcut, as keycaps.
  expect(view.container.querySelectorAll("kbd")).toHaveLength(3);
  fireEvent.click(view.getByRole("button", { name: "Got it" }));

  expect(view.queryByText("Stop anytime")).toBeNull();
  await waitFor(() => expect(patches).toEqual([{ clickyOnboarded: true }]));
  view.unmount();

  // Opened again, it has been seen.
  const again = render(<ClickyOnboarding />);
  await waitFor(() =>
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["settings", "preferences"] })
        .some(
          (query) =>
            (query.state.data as { clickyOnboarded?: boolean } | undefined)
              ?.clickyOnboarded === true,
        ),
    ).toBe(true),
  );
  expect(again.queryByText("Meet Clicky")).toBeNull();
  expect(patches).toHaveLength(1);
});

test("Skip counts as seen", async () => {
  preferences = { messageListEmphasis: "agent" };
  const view = render(<ClickyOnboarding />);
  fireEvent.click(await view.findByRole("button", { name: "Skip" }));
  expect(view.queryByText("Meet Clicky")).toBeNull();
  await waitFor(() => expect(patches).toEqual([{ clickyOnboarded: true }]));
});

test("somebody who has seen it never sees it", async () => {
  preferences = { messageListEmphasis: "agent", clickyOnboarded: true };
  const view = render(<ClickyOnboarding />);
  await waitFor(() =>
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["settings", "preferences"] })
        .some((query) => query.state.data !== undefined),
    ).toBe(true),
  );
  expect(view.queryByText("Meet Clicky")).toBeNull();
  expect(patches).toEqual([]);
});
