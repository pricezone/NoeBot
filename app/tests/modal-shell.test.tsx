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
import { ModalShell, type ModalNavItem } from "@/components/ui/modal-shell";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/queries";
import { clearReturnTo, rememberReturnTo } from "@/lib/return-to";

/**
 * The modal route shell: a dialog that is open for as long as its route is mounted. Escape and
 * the X are the one close, which is `onClose` when given and otherwise a navigation to `closeTo`
 * or to the location the app shell last remembered. Rows marked `adminOnly` show only to an
 * administrator, read from the same current-user query the rest of the app gates on.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  clearReturnTo();
});
afterAll(() => GlobalRegistrator.unregister());

const NAV: ModalNavItem[] = [
  { id: "general", label: "General", to: "/settings", exact: true },
  { id: "bots", label: "Bots", to: "/settings/bots" },
  { id: "admin", label: "Admin", to: "/admin", adminOnly: true },
];

function person(role: AuthenticatedUser["role"]): AuthenticatedUser {
  return {
    id: "user-1",
    email: "person@example.com",
    role,
    onboarding: null,
  };
}

function draw(
  role: AuthenticatedUser["role"],
  props: { closeTo?: string; onClose?: () => void; title?: string } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(authKeys.currentUser(), person(role));

  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    path: "/settings",
    getParentRoute: () => rootRoute,
    component: () => (
      <ModalShell
        nav={NAV}
        title={props.title ?? "Settings"}
        width={1100}
        closeTo={props.closeTo}
        onClose={props.onClose}
      >
        <p>Body</p>
      </ModalShell>
    ),
  });
  const page = (label: string) =>
    createRoute({
      path: label,
      getParentRoute: () => rootRoute,
      component: () => <p>{`At ${label}`}</p>,
    });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
    routeTree: rootRoute.addChildren([
      settingsRoute,
      page("/"),
      page("/channel/abc"),
      page("/elsewhere"),
      page("/admin"),
    ]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("the title is rendered and names the dialog", async () => {
  const { view } = draw("user");
  const dialog = await view.findByRole("dialog", { name: "Settings" });
  expect(dialog).toBeTruthy();
  // The visible copy, besides the accessible name.
  expect(view.getAllByText("Settings").length).toBeGreaterThanOrEqual(2);
  expect(view.getByText("Body")).toBeTruthy();
});

test("admin-only rows hide for a user and show for an admin", async () => {
  const asUser = draw("user");
  await asUser.view.findByRole("dialog");
  expect(asUser.view.getAllByRole("link", { name: "General" }).length).toBe(2);
  expect(asUser.view.queryAllByRole("link", { name: "Admin" })).toHaveLength(0);
  cleanup();

  const asAdmin = draw("admin");
  await asAdmin.view.findByRole("dialog");
  expect(asAdmin.view.getAllByRole("link", { name: "Admin" }).length).toBe(2);
});

test("the active row lights from the URL, honouring exact", async () => {
  const { view } = draw("user");
  await view.findByRole("dialog");
  const [general] = view.getAllByRole("link", { name: "General" });
  const [bots] = view.getAllByRole("link", { name: "Bots" });
  expect(general?.getAttribute("aria-current")).toBe("page");
  expect(bots?.getAttribute("aria-current")).toBeNull();
});

test("Escape calls onClose when given", async () => {
  let closed = 0;
  const { view, router } = draw("user", {
    onClose: () => {
      closed += 1;
    },
  });
  await view.findByRole("dialog");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(closed).toBe(1));
  // onClose owns the decision: the shell did not also navigate.
  expect(router.state.location.pathname).toBe("/settings");
});

test("the X navigates to closeTo", async () => {
  const { view, router } = draw("user", { closeTo: "/elsewhere" });
  await view.findByRole("dialog");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/elsewhere"),
  );
  await view.findByText("At /elsewhere");
});

test("with neither, Escape goes back to the remembered location", async () => {
  rememberReturnTo("/channel/abc");
  const { view, router } = draw("user");
  await view.findByRole("dialog");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/channel/abc"),
  );
});

test("with nothing remembered, the fallback is the home route", async () => {
  const { view, router } = draw("user");
  await view.findByRole("dialog");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
});
