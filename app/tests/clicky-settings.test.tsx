import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  ClickyPhonesSection,
  ClickySettingsSection,
} from "@/components/clicky/clicky-settings";
import { queryClient } from "@/query-client";
import type { MobileDevice } from "../../shared/mobile-link";
import { settleReactWork } from "./settle-react-work";

/**
 * Settings › Clicky: each setting takes effect when changed and is saved as its own flat key; the
 * phones linked through the HyperNoesis app are listed with Revoke, and a server too old to keep
 * that list hides the section rather than showing an error.
 */

let preferences: Record<string, unknown> = {};
let patches: Record<string, unknown>[] = [];
let devices: MobileDevice[] | null = [];
let deleted: string[] = [];
const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
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
    if (url === "/api/mobile/devices")
      return devices === null
        ? Response.json({ error: "Not found" }, { status: 404 })
        : Response.json({ devices });
    const revoke = /^\/api\/mobile\/devices\/(.+)$/.exec(url);
    if (revoke?.[1] && init?.method === "DELETE") {
      deleted.push(revoke[1]);
      devices = (devices ?? []).filter((device) => device.id !== revoke[1]);
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  patches = [];
  deleted = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

const draw = (children: React.ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );

const PHONE: MobileDevice = {
  id: "phone-1",
  name: "Maria's iPhone",
  platform: "ios",
  createdAt: "2026-10-01T09:00:00Z",
  lastSeenAt: "2026-10-14T09:00:00Z",
  clickyBotId: null,
  pushEnabled: true,
  current: false,
};

test("auto-open is on by default, and switching it off saves only that", async () => {
  preferences = { messageListEmphasis: "agent" };
  const view = draw(<ClickySettingsSection />);
  const toggle = await view.findByRole("switch", {
    name: "Open when Noë Bot needs you",
  });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  await waitFor(() => expect(toggle.hasAttribute("data-disabled")).toBe(false));

  fireEvent.click(toggle);
  await waitFor(() => expect(patches).toEqual([{ clickyAutoActivate: false }]));
  await waitFor(() =>
    expect(toggle.getAttribute("aria-checked")).toBe("false"),
  );
  // Asking once per session is what somebody who never chose gets.
  expect(view.getByText("Ask once per session")).toBeTruthy();
});

test("linked phones are listed and Revoke signs one out", async () => {
  devices = [PHONE];
  const view = draw(<ClickyPhonesSection />);
  expect(await view.findByText("Maria's iPhone")).toBeTruthy();
  expect(view.getByText(/^iOS · last used /)).toBeTruthy();

  fireEvent.click(view.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(deleted).toEqual(["phone-1"]));
  await waitFor(() => expect(view.queryByText("Maria's iPhone")).toBeNull());
  expect(view.getByText(/No phones are linked/)).toBeTruthy();
});

test("on a server without the list, there is no Phones section at all", async () => {
  devices = null;
  const view = draw(<ClickyPhonesSection />);
  await waitFor(() =>
    expect(queryClient.getQueryState(["clicky", "devices"])?.status).toBe(
      "success",
    ),
  );
  expect(view.queryByText("Phones")).toBeNull();
  devices = [];
});
