import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
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
import { ThemeProvider } from "@/components/theme-provider";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { HOTKEYS } from "@/lib/hotkeys/hotkeys";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { Route as GeneralRoute } from "@/routes/_authed/_app/settings/index";

/**
 * Settings › General: the account card says who is signed in, the theme row changes the theme
 * this browser paints and stores, and every shortcut in the registry is listed. Rendered through
 * a memory router because the page draws router links (the sign-out navigates, the admin's gallery
 * row is a `Link`), and inside the theme provider because the theme row is what it is testing.
 */

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let requests: string[];

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  requests = [];
  window.localStorage.clear();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/settings/preferences") {
        return Response.json({ preferences: { messageListEmphasis: "agent" } });
      }
      if (path === "/api/settings/instructions") {
        return Response.json({ instructions: "" });
      }
      return Response.json({ error: `Unexpected ${path}` }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  cleanup();
  // React schedules the unmount's passive-effect flush as a macrotask. Let it run while the DOM is
  // still registered, or it reads `window` after `afterAll` has taken it away.
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
  document.documentElement.classList.remove("dark");
});
afterAll(() => GlobalRegistrator.unregister());

function person(role: AuthenticatedUser["role"]): AuthenticatedUser {
  return {
    id: "user-1",
    name: "Alice Example",
    email: "alice@example.com",
    role,
    onboarding: null,
  };
}

function draw(role: AuthenticatedUser["role"] = "user") {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(authKeys.currentUser(), person(role));

  const General = GeneralRoute.options.component!;
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    path: "/settings",
    getParentRoute: () => rootRoute,
    component: () => <General />,
  });
  const gallery = createRoute({
    path: "/settings/components-gallery",
    getParentRoute: () => rootRoute,
    component: () => <p>Gallery</p>,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
    routeTree: rootRoute.addChildren([settingsRoute, gallery]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the account card shows the name and the email", async () => {
  const { view } = draw();
  expect(await view.findByText("Alice Example")).toBeTruthy();
  expect(view.getByText("alice@example.com")).toBeTruthy();
  expect(view.getByRole("button", { name: "Copy email" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Sign out" })).toBeTruthy();
});

test("the theme select changes the theme this browser paints and stores", async () => {
  const { view } = draw();
  const trigger = await view.findByRole("combobox", { name: "Theme" });
  expect(trigger.textContent).toContain("Follow system");
  expect(document.documentElement.classList.contains("dark")).toBe(false);

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(trigger);
  await user.click(await view.findByRole("option", { name: "Dark" }));

  await waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(true),
  );
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  await waitFor(() =>
    expect(view.getByRole("combobox", { name: "Theme" }).textContent).toContain(
      "Dark",
    ),
  );
});

test("every registered shortcut is listed", async () => {
  const { view } = draw();
  await view.findByText("Alice Example");
  for (const hotkey of HOTKEYS) {
    expect(view.getByText(hotkey.label)).toBeTruthy();
  }
});

test("the component gallery row is offered to an administrator only", async () => {
  const asUser = draw("user");
  await asUser.view.findByText("Alice Example");
  expect(asUser.view.queryByText("Component gallery")).toBeNull();
  cleanup();

  const asAdmin = draw("admin");
  await asAdmin.view.findByText("Alice Example");
  expect(asAdmin.view.getByText("Component gallery")).toBeTruthy();
});
