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
import { Route as AdminRoute } from "@/routes/_authed/_app/admin/route";

/**
 * Admin is a section of the Settings popup, not a screen of its own: its layout draws the
 * Settings modal with the Settings nav, lights the Admin row on every `/admin/*` address, and
 * puts a Back to Admin above a screen one level down — and not above one two levels down, which
 * carries its own Back to its parent.
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
  const adminLayout = createRoute({
    path: "/admin",
    getParentRoute: () => rootRoute,
    component: AdminRoute.options.component,
  });
  const page = (path: string, title: string) =>
    createRoute({
      path,
      getParentRoute: () => adminLayout,
      component: () => <PageShell title={title}>{title} body</PageShell>,
    });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    routeTree: rootRoute.addChildren([
      adminLayout.addChildren([
        page("/", "Admin"),
        page("/credentials", "Credentials"),
        page("/plugins/$key", "One plugin"),
      ]),
      createRoute({
        path: "/settings",
        getParentRoute: () => rootRoute,
        component: () => <p>Settings page</p>,
      }),
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the Admin index is drawn inside the Settings popup, with the Admin row lit and no Back", async () => {
  const { view } = draw("/admin");
  const dialog = await view.findByRole("dialog", { name: "Settings" });
  const nav = within(dialog).getByRole("navigation", { name: "Settings" });
  const row = within(nav).getByRole("link", { name: "Admin" });
  await waitFor(() => expect(row.getAttribute("aria-current")).toBe("page"));
  expect(within(nav).getByRole("link", { name: "General" })).toBeTruthy();
  expect(within(dialog).getByRole("heading", { name: "Admin" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Back to Admin" })).toBeNull();
  // Inside the modal the shell never offers to hide a sidebar that is behind the overlay.
  expect(view.queryByRole("button", { name: /sidebar/i })).toBeNull();
});

test("a screen one level down keeps the popup and the lit row, and Back to Admin returns to the index", async () => {
  const { view, router } = draw("/admin/credentials");
  const dialog = await view.findByRole("dialog", { name: "Settings" });
  const nav = within(dialog).getByRole("navigation", { name: "Settings" });
  await waitFor(() =>
    expect(
      within(nav)
        .getByRole("link", { name: "Admin" })
        .getAttribute("aria-current"),
    ).toBe("page"),
  );
  expect(
    within(dialog).getByRole("heading", { name: "Credentials" }),
  ).toBeTruthy();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("button", { name: "Back to Admin" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/admin"));
  expect(await view.findByRole("heading", { name: "Admin" })).toBeTruthy();
});

test("a screen two levels down draws no Back to Admin of its own", async () => {
  const { view } = draw("/admin/plugins/treg");
  await view.findByRole("dialog", { name: "Settings" });
  expect(await view.findByRole("heading", { name: "One plugin" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Back to Admin" })).toBeNull();
});
