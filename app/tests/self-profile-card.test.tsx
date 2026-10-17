import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelfProfileCard } from "@/components/chat-cards/self-profile-card";
import { type UiLanguage, UiLanguageProvider } from "@/lib/i18n/strings";
import type { SelfProfileChange } from "../../shared/self-profile";
import type { AgentProfileStore } from "../../server/src/agents/profile-store";
import type {
  AgentProfile,
  CreateAgentInput,
} from "../../server/src/agents/profile-types";
import { createAgentRoutes } from "../../server/src/agents/routes";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot naming itself, as the conversation draws it: "Named itself Quill · role", and an Undo that
 * puts the previous name and role back through the profile form's own route. The routes are the
 * server's own behind `fetch`, as in `agent-avatar-editor.test.tsx`, so what Undo sends is checked by
 * the real parser.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const CHANGE: SelfProfileChange = {
  updated: true,
  bot: "agent_new",
  name: "Quill",
  role: "Researches topics and writes clear drafts.",
  title: "Researches topics and writes clear drafts.",
  previous: {
    name: "New Bot",
    role: "Help with whatever comes up.",
    title: "General assistant",
  },
  note: "Your profile now says this.",
};

/** The Bot as it is after renaming itself, and every profile write Undo makes. */
function serve() {
  const writes: CreateAgentInput[] = [];
  const actor = {
    id: "owner",
    email: "owner@example.test",
    role: "user" as const,
  };
  let profile: AgentProfile = {
    id: CHANGE.bot,
    name: CHANGE.name,
    title: CHANGE.title,
    roleDescription: CHANGE.role,
    avatarSeed: "seed",
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
  };
  const store = {
    get: async () => profile,
    update: async (_actor: unknown, _id: string, input: CreateAgentInput) => {
      writes.push(input);
      profile = { ...profile, ...input, endpoint: null };
      return profile;
    },
  } as unknown as AgentProfileStore;
  const routes = createAgentRoutes(store, async (context, next) => {
    context.set("actor", actor);
    await next();
  });
  globalThis.fetch = Object.assign(
    async (
      path: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof path !== "string" || !path.startsWith("/api/agents/"))
        throw new Error(`unexpected ${String(path)}`);
      return routes.request(
        new Request(
          `http://openbot.test${path.slice("/api/agents".length)}`,
          init,
        ),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  return { writes };
}

function draw(
  props: Parameters<typeof SelfProfileCard>[0],
  language: UiLanguage = "en",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidated = spyOn(client, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={client}>
      <UiLanguageProvider language={language}>
        <SelfProfileCard {...props} />
      </UiLanguageProvider>
    </QueryClientProvider>,
  );
  return { view, invalidated };
}

describe("a Bot naming itself", () => {
  test("says what it named itself, and refreshes everything that shows its name", async () => {
    const { view, invalidated } = draw({
      toolCallId: "call-name-1",
      result: JSON.stringify(JSON.stringify(CHANGE)),
      running: false,
    });

    expect(view.getByText("Named itself Quill")).toBeTruthy();
    expect(
      view.getByText(/Researches topics and writes clear drafts\./),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        invalidated.mock.calls.map(([filters]) => filters?.queryKey),
      ).toEqual([["agents"], ["channels"]]),
    );
  });

  test("Undo puts the previous name, role and title back through the profile route", async () => {
    const { writes } = serve();
    const { view } = draw({
      toolCallId: "call-name-2",
      result: JSON.stringify(CHANGE),
      running: false,
    });
    const user = userEvent.setup({ document });

    await user.click(view.getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(view.getByText("Back to New Bot")).toBeTruthy());
    expect(writes).toEqual([
      {
        name: "New Bot",
        title: "General assistant",
        roleDescription: "Help with whatever comes up.",
        visibility: "private",
        endpoint: undefined,
        auth: undefined,
      },
    ]);
    expect(view.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  test("speaks the conversation's language", () => {
    const { view } = draw(
      {
        toolCallId: "call-name-3",
        result: JSON.stringify({ ...CHANGE, name: "Πένα" }),
        running: false,
      },
      "el",
    );
    expect(view.getByText("Ονομάστηκε Πένα")).toBeTruthy();
    expect(view.getByRole("button", { name: "Αναίρεση" })).toBeTruthy();
  });

  test("a refused rename is a line that says so, with nothing to undo", () => {
    const { view } = draw({
      toolCallId: "call-name-4",
      result: JSON.stringify(
        'Refused. Nothing was changed: "Διεκπ." is a shortened word.',
      ),
      running: false,
    });
    expect(view.getByText(/didn't work/)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  test("while it runs, it says it is naming itself", () => {
    const { view } = draw({ name: "Quill", result: undefined, running: true });
    expect(view.getByText("Naming itself")).toBeTruthy();
  });
});
