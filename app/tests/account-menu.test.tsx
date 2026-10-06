import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AccountMenu,
  initialsOf,
  usageRowLabel,
} from "@/components/app-sidebar/account-menu";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { readReturnTo, rememberReturnTo } from "@/lib/return-to";
import { usageKeys } from "@/lib/usage/queries";

/**
 * The menu behind the sidebar's avatar: rows gated on what the deployment can do and who is
 * asking, the usage figure in words, the approvals count on its row, and a sign-out that forgets
 * where a modal would have closed back to.
 */

let originalFetch: typeof fetch;
let requests: { path: string; method: string }[] = [];
let respond: (path: string) => Promise<Response>;
const clients: QueryClient[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push({ path, method: init?.method ?? "GET" });
      return respond(path);
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  requests = [];
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function person(role: AuthenticatedUser["role"]): AuthenticatedUser {
  return {
    id: "user-1",
    name: "Hélène Noé",
    email: "helene@example.com",
    role,
    onboarding: null,
  };
}

function draw(input: {
  role?: AuthenticatedUser["role"];
  usage?: boolean;
  pending?: number;
  weekCredits?: number;
}) {
  respond = async (path) => {
    if (path === "/api/approvals") {
      return Response.json({
        enabled: true,
        requests: [
          ...Array.from({ length: input.pending ?? 0 }, (_, index) => ({
            id: `pending-${index}`,
            status: "pending",
          })),
          { id: "done", status: "approved" },
        ],
        rules: [],
        teamRules: [],
        questions: [],
      });
    }
    if (path === "/api/auth/sign-out" || path.includes("sign-out")) {
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(authKeys.currentUser(), person(input.role ?? "user"));
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    usage: input.usage ?? false,
  });
  if (input.weekCredits !== undefined) {
    client.setQueryData(usageKeys.summary(), {
      period: { from: "2026-09-29T00:00:00Z", to: "2026-10-06T00:00:00Z" },
      week: { credits: input.weekCredits, requests: 12 },
      month: { credits: input.weekCredits * 3, requests: 40 },
      balance: 10_000,
    });
  }

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AccountMenu />
        <Outlet />
      </>
    ),
  });
  const page = (path: string, label: string) =>
    createRoute({
      path,
      getParentRoute: () => rootRoute,
      component: () => <p>{label}</p>,
    });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([
      page("/", "Home"),
      page("/settings", "Settings page"),
      page("/settings/usage", "Usage page"),
      page("/settings/approvals", "Approvals page"),
      page("/admin", "Admin page"),
      page("/sign", "Sign in"),
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router, client };
}

async function open(view: ReturnType<typeof draw>["view"]) {
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Account menu" }));
  await view.findByRole("link", { name: "Settings" });
  return user;
}

test("initials come from the name, else from the address", () => {
  expect(initialsOf({ name: "Hélène Noé", email: "h@example.com" })).toBe("HN");
  expect(initialsOf({ name: "  solo ", email: "h@example.com" })).toBe("S");
  expect(initialsOf({ name: null, email: "ab@example.com" })).toBe("AB");
});

test("the usage row says the week's credits, or just Usage while unknown", () => {
  expect(usageRowLabel(undefined)).toBe("Usage");
  expect(usageRowLabel(12480.4)).toBe("Usage · 12,480 credits this week");
});

test("the trigger shows the person's initials and opens the menu", async () => {
  const { view } = draw({});
  const trigger = await view.findByRole("button", { name: "Account menu" });
  expect(trigger.textContent).toBe("HN");
  await open(view);
  expect(view.getByRole("link", { name: "Approvals" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Log out" })).toBeTruthy();
});

test("the usage row exists only on a metered deployment, and links to the usage tab", async () => {
  const ownKey = draw({ usage: false, weekCredits: 500 });
  await open(ownKey.view);
  expect(ownKey.view.queryByRole("link", { name: /Usage/ })).toBeNull();
  cleanup();

  const metered = draw({ usage: true, weekCredits: 1234 });
  await open(metered.view);
  const row = metered.view.getByRole("link", {
    name: "Usage · 1,234 credits this week",
  });
  expect(row.getAttribute("href")).toBe("/settings/usage");
});

test("the Approvals row carries the pending count and nothing else is counted", async () => {
  const { view } = draw({ pending: 2 });
  await open(view);
  const row = view.getByRole("link", { name: /Approvals/ });
  expect(row.getAttribute("href")).toBe("/settings/approvals");
  await waitFor(() => expect(row.textContent).toContain("2"));
  expect(row.textContent).not.toContain("3");
  // The count is asked for only once the menu is open.
  expect(requests.map((request) => request.path)).toEqual(["/api/approvals"]);
});

test("Admin shows only to an administrator", async () => {
  const asUser = draw({ role: "user" });
  await open(asUser.view);
  expect(asUser.view.queryByRole("link", { name: "Admin" })).toBeNull();
  cleanup();

  const asAdmin = draw({ role: "admin" });
  await open(asAdmin.view);
  expect(
    asAdmin.view.getByRole("link", { name: "Admin" }).getAttribute("href"),
  ).toBe("/admin");
});

test("a row navigates and closes the menu", async () => {
  const { view, router } = draw({});
  const user = await open(view);
  await user.click(view.getByRole("link", { name: "Settings" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
  await view.findByText("Settings page");
  await waitFor(() =>
    expect(view.queryByRole("link", { name: "Approvals" })).toBeNull(),
  );
});

test("logging out forgets the remembered return location and goes to sign-in", async () => {
  rememberReturnTo("/channel/abc");
  const { view, router } = draw({});
  const user = await open(view);
  await user.click(view.getByRole("button", { name: "Log out" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/sign"));
  expect(readReturnTo("/fallback")).toBe("/fallback");
});
