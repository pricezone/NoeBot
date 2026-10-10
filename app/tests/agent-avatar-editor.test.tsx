import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { queryClient } from "@/query-client";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type {
  AgentProfile,
  AvatarChoice,
} from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";

/**
 * Choosing a Bot's avatar in its dialog: Profile, a swatch or a face, and it is saved.
 *
 * The routes are the server's own, mounted behind `fetch` the way `agent-dialog-built-in-edit`
 * mounts them, so what a click sends is checked by the real parser and who may send it by the real
 * policy. The editor imports the app's one query client, as every screen does, so this draws the
 * dialog inside that same client and empties it between tests.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Every avatar choice the store was asked to write, as the route parsed it. */
let choices: AvatarChoice[] = [];

function serve({
  role = "user",
  ...overrides
}: Partial<AgentProfile> & { role?: "admin" | "user" } = {}) {
  choices = [];
  const actor = { id: "owner", email: "owner@example.test", role };
  let profile: AgentProfile = {
    id: "expenses",
    name: "Expenses",
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    avatarSeed: "expenses",
    avatarColor: null,
    avatarExpression: null,
    visibility: "private",
    ownerUserId: actor.id,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
  const store = {
    get: async () => profile,
    setAvatar: async (_actor: unknown, _id: string, choice: AvatarChoice) => {
      choices.push({ ...choice });
      profile = { ...profile, ...choice };
      return profile;
    },
  } as unknown as AgentProfileStore;
  const auth: Parameters<typeof createAgentRoutes>[1] = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const routes = createAgentRoutes(store, auth);
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof path !== "string" || !path.startsWith("/api/agents/")) {
        throw new Error(`unexpected ${String(path)}`);
      }
      return routes.request(
        new Request(
          `http://openbot.test${path.slice("/api/agents".length)}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
}

/** The dialog, opened on its Profile section. */
async function openProfile() {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({
      component: () => (
        <AgentDialog agentId="expenses" onClose={() => {}} open />
      ),
    }),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  // The sidebar and the phone's strip both name the section; no stylesheet hides either here.
  const [section] = await view.findAllByRole("button", { name: "Profile" });
  if (!section) throw new Error("no Profile section");
  await user.click(section);
  return { view, user };
}

/** The large preview, which is the avatar announced as the Bot's. */
function preview(view: ReturnType<typeof render>) {
  const avatar = view.getByRole("img", { name: "Expenses's avatar" });
  return {
    background: avatar.style.backgroundColor,
    face: avatar.querySelector("svg")?.getAttribute("data-face"),
  };
}

test("a colour is saved on the click, and the avatar takes it", async () => {
  serve();
  const { view, user } = await openProfile();

  const blue = await view.findByRole("button", { name: "Blue" });
  expect(blue.getAttribute("aria-pressed")).toBe("false");
  await user.click(blue);

  await waitFor(() => expect(choices).toEqual([{ avatarColor: "#2563eb" }]));
  await waitFor(() => expect(preview(view).background).toBe("#2563eb"));
  expect(
    view.getByRole("button", { name: "Blue" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

test("an expression is saved on the click, and only the expression", async () => {
  serve({ avatarColor: "#16a34a" });
  const { view, user } = await openProfile();

  // Fifteen faces, each a labelled button.
  const faces = view.getByRole("group", { name: "Expression" });
  expect(faces.querySelectorAll("button")).toHaveLength(15);
  await user.click(view.getByRole("button", { name: "Happy" }));

  await waitFor(() => expect(choices).toEqual([{ avatarExpression: "happy" }]));
  await waitFor(() => expect(preview(view).face).toBe("happy"));
  // The colour chosen before is untouched by choosing a face.
  expect(preview(view).background).toBe("#16a34a");
});

test("Reset hands both halves back to the seed", async () => {
  serve({ avatarColor: "#7c3aed", avatarExpression: "shy" });
  const { view, user } = await openProfile();

  await user.click(await view.findByRole("button", { name: "Reset" }));

  await waitFor(() =>
    expect(choices).toEqual([{ avatarColor: null, avatarExpression: null }]),
  );
  // With nothing chosen there is nothing to reset.
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Reset" })).toBeNull(),
  );
});

test("somebody who may not change it is shown the avatar and why, and no swatches", async () => {
  serve({ ownerUserId: "someone-else", visibility: "public" });
  const { view } = await openProfile();

  await view.findByText(
    "Only its owner or an administrator can change how it looks.",
  );
  expect(view.getByRole("img", { name: "Expenses's avatar" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Blue" })).toBeNull();
  expect(view.queryByRole("group", { name: "Expression" })).toBeNull();
});

test("an administrator may restyle a Bot the deployment ships, which nobody may otherwise edit", async () => {
  serve({
    role: "admin",
    ownerUserId: null,
    systemOwned: true,
    visibility: "public",
  });
  const { view, user } = await openProfile();

  await user.click(await view.findByRole("button", { name: "Teal" }));

  await waitFor(() => expect(choices).toEqual([{ avatarColor: "#0d9488" }]));
});
