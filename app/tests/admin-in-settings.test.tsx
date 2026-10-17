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
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PageShell } from "@/components/layout/page-shell";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { deploymentKeys } from "@/lib/deployment/queries";
import { advancedSettingsHref } from "@/lib/settings/advanced-path";
import { Route as AdminRedirectRoute } from "@/routes/_authed/_app/admin/$";
import { Route as AdvancedRoute } from "@/routes/_authed/_app/settings/advanced/route";
import { Route as SettingsRoute } from "@/routes/_authed/_app/settings/route";

/**
 * Advanced Settings (once Admin) is a section of the Settings popup, not a screen of its own: it is
 * a child of `/settings`, so it draws inside the one Settings modal with the Advanced Settings row
 * lit, moving to it from another section keeps that modal (no close and re-open), and a screen one
 * level down gets a Back to Advanced Settings — not one two levels down, which carries its own Back.
 * The old `/admin/*` addresses redirect to the same screen there.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function admin(): AuthenticatedUser {
  return {
    id: "user-1",
    name: "Hélène Noé",
    email: "helene@example.com",
    role: "admin",
    onboarding: null,
  };
}

function draw(initialPath: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(authKeys.currentUser(), admin());
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    usage: false,
  });

  const rootRoute = createRootRoute({ component: Outlet });
  const settingsLayout = createRoute({
    path: "/settings",
    getParentRoute: () => rootRoute,
    component: SettingsRoute.options.component,
  });
  const advancedLayout = createRoute({
    path: "/advanced",
    getParentRoute: () => settingsLayout,
    component: AdvancedRoute.options.component,
  });
  const page = (path: string, title: string) =>
    createRoute({
      path,
      getParentRoute: () => advancedLayout,
      component: () => <PageShell title={title}>{title} body</PageShell>,
    });
  // The old addresses, with the real redirect.
  const oldAdmin = createRoute({
    path: "/admin/$",
    getParentRoute: () => rootRoute,
    // The real redirect; it only reads `location`, but is typed against its `_app` parent.
    beforeLoad: (context) =>
      (
        AdminRedirectRoute.options.beforeLoad as unknown as (
          context: unknown,
        ) => void
      )(context),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    routeTree: rootRoute.addChildren([
      settingsLayout.addChildren([
        createRoute({
          path: "/",
          getParentRoute: () => settingsLayout,
          component: () => <p>General page</p>,
        }),
        advancedLayout.addChildren([
          page("/", "Advanced Settings"),
          page("/credentials", "Credentials"),
          page("/plugins/$key", "One plugin"),
        ]),
      ]),
      oldAdmin,
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the Advanced Settings index is drawn inside the Settings popup, with its row lit and no Back", async () => {
  const { view } = draw("/settings/advanced");
  const dialog = await view.findByRole("dialog", { name: "Settings" });
  const nav = within(dialog).getByRole("navigation", { name: "Settings" });
  const row = within(nav).getByRole("link", { name: "Advanced Settings" });
  await waitFor(() => expect(row.getAttribute("aria-current")).toBe("page"));
  expect(within(nav).getByRole("link", { name: "General" })).toBeTruthy();
  expect(
    await within(dialog).findByRole("heading", { name: "Advanced Settings" }),
  ).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Back to Advanced Settings" }),
  ).toBeNull();
  // Inside the modal the shell never offers to hide a sidebar that is behind the overlay.
  expect(view.queryByRole("button", { name: /sidebar/i })).toBeNull();
});

test("moving from General to Advanced Settings keeps the same popup open", async () => {
  const { view, router } = draw("/settings");
  const dialog = await view.findByRole("dialog", { name: "Settings" });
  await view.findByText("General page");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(
    within(dialog).getAllByRole("link", {
      name: "Advanced Settings",
    })[0] as HTMLElement,
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/settings/advanced"),
  );
  await view.findByRole("heading", { name: "Advanced Settings" });
  // The very same dialog element: the section swapped inside it, nothing closed or re-opened.
  expect(view.getByRole("dialog", { name: "Settings" })).toBe(dialog);
});

test("a screen one level down keeps the popup and the lit row, and Back returns to the index", async () => {
  const { view, router } = draw("/settings/advanced/credentials");
  const dialog = await view.findByRole("dialog", { name: "Settings" });
  const nav = within(dialog).getByRole("navigation", { name: "Settings" });
  await waitFor(() =>
    expect(
      within(nav)
        .getByRole("link", { name: "Advanced Settings" })
        .getAttribute("aria-current"),
    ).toBe("page"),
  );
  expect(
    within(dialog).getByRole("heading", { name: "Credentials" }),
  ).toBeTruthy();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(
    view.getByRole("button", { name: "Back to Advanced Settings" }),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/settings/advanced"),
  );
  expect(
    await view.findByRole("heading", { name: "Advanced Settings" }),
  ).toBeTruthy();
  expect(view.getByRole("dialog", { name: "Settings" })).toBe(dialog);
});

test("a screen two levels down draws no Back to Advanced Settings of its own", async () => {
  const { view } = draw("/settings/advanced/plugins/treg");
  await view.findByRole("dialog", { name: "Settings" });
  expect(await view.findByRole("heading", { name: "One plugin" })).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Back to Advanced Settings" }),
  ).toBeNull();
});

test("the old /admin addresses redirect to the same screen in Advanced Settings", async () => {
  const index = draw("/admin");
  await waitFor(() =>
    expect(index.router.state.location.pathname).toBe("/settings/advanced"),
  );
  cleanup();

  const deep = draw("/admin/credentials?tab=keys");
  await waitFor(() =>
    expect(deep.router.state.location.pathname).toBe(
      "/settings/advanced/credentials",
    ),
  );
  expect(deep.router.state.location.searchStr).toBe("?tab=keys");
  expect(
    await deep.view.findByRole("heading", { name: "Credentials" }),
  ).toBeTruthy();
});

test("the path mapping keeps the rest of the address and leaves others alone", () => {
  expect(advancedSettingsHref("/admin")).toBe("/settings/advanced");
  expect(advancedSettingsHref("/admin/plugins/composio?app=gmail#top")).toBe(
    "/settings/advanced/plugins/composio?app=gmail#top",
  );
  expect(advancedSettingsHref("/admin?x=1")).toBe("/settings/advanced?x=1");
  expect(advancedSettingsHref("/administrators")).toBe("/administrators");
  expect(advancedSettingsHref("/settings")).toBe("/settings");
});
