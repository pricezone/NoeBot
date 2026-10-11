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
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { EditSkill } from "@/components/skills/edit-skill";
import { SkillsSections } from "@/components/skills/skills-sections";
import type { PluginSkill } from "@/lib/plugins/queries";

/**
 * The Skills tab's list, drawn with the Marketplace's rows: every skill behind the lightning mark,
 * Edit on a skill of yours and View on the workspace's, both opening the panel beside the list —
 * where deleting now lives, and where a member opening a workspace skill gets it to read rather
 * than a form the server would refuse.
 *
 * The harness is `skills-read-failure.test.tsx`'s: `GlobalRegistrator` around the file, the
 * component alone under a bare root route, a `QueryClient` that never retries.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = global.fetch;
let role: "user" | "admin";
/** Every write the deployment received, as `method path`. */
let writes: string[];
let skills: PluginSkill[];

const skill = (
  overrides: Partial<PluginSkill> & { slug: string },
): PluginSkill => ({
  id: overrides.slug,
  ownerUserId: "user-1",
  title: overrides.slug,
  summary: "",
  instructions: "Do it.",
  origin: "user",
  installedBy: null,
  pluginId: null,
  offeredToAllBots: false,
  grantedTo: [],
  tools: [],
  ...overrides,
});

beforeEach(() => {
  role = "user";
  writes = [];
  skills = [
    skill({ slug: "triage", title: "Triage", summary: "Sort the inbox." }),
    skill({ slug: "digest", title: "Digest" }),
    skill({
      slug: "treg-treg",
      title: "Treg",
      ownerUserId: null,
      origin: "plugin",
      pluginId: "55647425",
      offeredToAllBots: true,
    }),
    skill({
      slug: "check-a-claim",
      title: "Check a claim",
      summary: "Verify a statement.",
      ownerUserId: null,
      origin: "package",
    }),
  ];
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split("?")[0] ?? "";
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method !== "GET") writes.push(`${method} ${path}`);
      if (path === "/api/me") {
        return json({
          user: {
            id: "user-1",
            email: "person@example.com",
            role,
            onboarding: null,
          },
        });
      }
      if (path === "/api/plugins") {
        return json({
          catalogue: [],
          servers: [],
          skills,
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: false,
        });
      }
      const remove = path.match(/^\/api\/plugins\/skills\/([^/]+)$/);
      if (method === "DELETE" && remove) {
        const slug = decodeURIComponent(remove[1] ?? "");
        skills = skills.filter((candidate) => candidate.slug !== slug);
        return json({ removed: true });
      }
      if (path === "/api/agents") return json({ agents: [] });
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

/** A component that reads no route of its own, drawn under a root route for `Link`/`useNavigate`. */
function renderAlone(Component: ComponentType) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <Component /> }),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("every skill is a Marketplace row behind the lightning mark: Edit for yours, View for the workspace's", async () => {
  const { view } = renderAlone(SkillsSections);
  const triage = await view.findByTestId("skill-triage");

  for (const slug of ["triage", "digest", "treg-treg", "check-a-claim"]) {
    const row = view.getByTestId(`skill-${slug}`);
    expect(row.querySelector("svg[data-mark='skill']")).toBeTruthy();
  }
  expect(
    within(triage)
      .getByRole("link", { name: "Edit Triage" })
      .getAttribute("href"),
  ).toBe("/marketplace?tab=skills&edit=triage");
  expect(within(triage).getByText("Sort the inbox.")).toBeTruthy();
  // A skill written without a summary shows the command instead, which is what a person types.
  expect(
    within(view.getByTestId("skill-digest")).getByText("/digest"),
  ).toBeTruthy();

  const workspace = view.getByRole("region", { name: "Workspace skills" });
  expect(
    within(workspace)
      .getByRole("link", { name: "View Treg" })
      .getAttribute("href"),
  ).toBe("/marketplace?tab=skills&edit=treg-treg");
  expect(
    within(workspace).getByRole("link", { name: "View Check a claim" }),
  ).toBeTruthy();
  expect(within(workspace).queryByRole("link", { name: /^Edit/ })).toBeNull();
  // The old row's menu is gone: deleting lives in the panel now.
  expect(view.queryByRole("button", { name: /Delete/ })).toBeNull();
});

test("the search term travels with every link out of the list, and the row itself opens the panel", async () => {
  const { view, router } = renderAlone(() => <SkillsSections query="tri" />);
  const triage = await view.findByTestId("skill-triage");
  expect(view.queryByTestId("skill-digest")).toBeNull();
  expect(
    within(triage)
      .getByRole("link", { name: "Edit Triage" })
      .getAttribute("href"),
  ).toBe("/marketplace?tab=skills&q=tri&edit=triage");
  // A router Link drawn as a Button: it announces as a button and carries the address.
  expect(
    view.getByRole("button", { name: "New skill" }).getAttribute("href"),
  ).toBe("/marketplace?tab=skills&q=tri&new=true");

  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(
    within(triage).getByRole("button", { name: "About Triage" }),
  );
  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/marketplace");
    expect(router.state.location.search).toEqual({
      tab: "skills",
      q: "tri",
      edit: "triage",
    });
  });
});

test("deleting lives in the panel, names the skill, and closes the panel when done", async () => {
  let closed = 0;
  const { view } = renderAlone(() => (
    <EditSkill
      onClose={() => {
        closed += 1;
      }}
      slug="triage"
    />
  ));
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(await view.findByRole("button", { name: "Delete /triage" }));
  await waitFor(() => {
    expect(writes).toContain("DELETE /api/plugins/skills/triage");
    expect(closed).toBe(1);
  });
});

test("a member opens a workspace skill to read it; an administrator gets the form", async () => {
  const asMember = renderAlone(() => <EditSkill slug="check-a-claim" />);
  expect(
    await asMember.view.findByRole("heading", { name: "Check a claim" }),
  ).toBeTruthy();
  expect(asMember.view.getByText(/A workspace skill/)).toBeTruthy();
  expect(asMember.view.getByText("Do it.")).toBeTruthy();
  expect(
    asMember.view.queryByRole("button", { name: "Save changes" }),
  ).toBeNull();
  expect(asMember.view.queryByRole("button", { name: /^Delete/ })).toBeNull();
  cleanup();

  role = "admin";
  const asAdmin = renderAlone(() => <EditSkill slug="check-a-claim" />);
  expect(
    await asAdmin.view.findByRole("button", { name: "Save changes" }),
  ).toBeTruthy();
  expect(
    asAdmin.view.getByRole("button", { name: "Delete /check-a-claim" }),
  ).toBeTruthy();
});
