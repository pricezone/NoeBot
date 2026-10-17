import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  OfferMarketplaceCard,
  OfferTemplateCard,
} from "@/components/chat-cards/offer-cards";
import { i18n } from "@/lib/i18n";
import { resetI18nForTests } from "@/lib/i18n/set-locale";
import {
  type AddedItem,
  connectPageFor,
  type MarketplaceItem,
  type MarketplaceOfferAnswer,
  marketplaceAnswer,
  readMarketplaceAnswer,
  readTemplateAnswer,
  type TemplateApplied,
  type TemplateOfferAnswer,
} from "@/lib/suggestions/offers";
import { settleReactWork } from "./settle-react-work";

/**
 * The two cards a Bot offers a template or a Marketplace item on, and every answer they give.
 *
 * Each card IS its tool: no handler stands behind it, so every way out is a `respond` call, and
 * the write behind Yes is a prop here, exercised with plain functions and no transport. The
 * properties pinned: Yes writes once and says what changed, No and a typed answer write nothing,
 * an item that needs an account is never added from the chat — the card opens the page where it
 * is connected instead — and the person reads all of it in Greek when their interface is.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup({ document });
});
afterEach(async () => {
  cleanup();
  await resetI18nForTests();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const TEMPLATE = {
  id: "research-desk",
  name: "Research Desk",
  summary:
    "Reads around a question and writes a brief somebody can act on, naming what it could not find.",
};

const APPLIED: TemplateApplied = {
  name: "Research Desk",
  renamed: true,
  title: "Briefings",
  instructions: true,
  avatar: true,
  skills: ["research-public-web", "check-a-claim"],
  failedSkills: [],
};

/** A respond that records what it was answered with, as the runtime would serialise it. */
function recorder() {
  const answers: unknown[] = [];
  return {
    answers,
    respond: async (result: unknown) => {
      answers.push(result);
    },
  };
}

describe("offering a template", () => {
  test("names the template, says what applying does, and offers Apply, No and own words", () => {
    const { respond } = recorder();
    const view = render(
      <OfferTemplateCard
        apply={async () => APPLIED}
        args={{ templateId: "research-desk", reason: "You research a lot." }}
        respond={respond}
        template={TEMPLATE}
      />,
    );
    expect(view.getByText("Apply the Research Desk template?")).toBeTruthy();
    expect(view.getByText(TEMPLATE.summary)).toBeTruthy();
    expect(view.getByText("You research a lot.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Apply it" })).toBeTruthy();
    expect(view.getByRole("button", { name: "No" })).toBeTruthy();
    expect(view.getByPlaceholderText("Type your own answer")).toBeTruthy();
  });

  test("Apply applies once and tells the Bot what changed", async () => {
    const { answers, respond } = recorder();
    let applied = 0;
    const view = render(
      <OfferTemplateCard
        apply={async () => {
          applied += 1;
          return APPLIED;
        }}
        args={{ templateId: "research-desk" }}
        respond={respond}
        template={TEMPLATE}
      />,
    );
    await user.click(view.getByRole("button", { name: "Apply it" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(applied).toBe(1);
    const answer = answers[0] as TemplateOfferAnswer;
    expect(answer).toMatchObject({
      outcome: "applied",
      templateId: "research-desk",
      applied: APPLIED,
    });
    expect(answer.note).toContain("research-public-web, check-a-claim");
    expect(answer.note).toContain("now called Research Desk");
    expect(answer.note).toContain("Marketplace");
    // Collapsed to the one row picked: there is nothing left to press.
    await waitFor(() =>
      expect(view.queryByRole("button", { name: "No" })).toBeNull(),
    );
  });

  test("No reports the decline and applies nothing", async () => {
    const { answers, respond } = recorder();
    let applied = 0;
    const view = render(
      <OfferTemplateCard
        apply={async () => {
          applied += 1;
          return APPLIED;
        }}
        args={{ templateId: "research-desk" }}
        respond={respond}
        template={TEMPLATE}
      />,
    );
    await user.click(view.getByRole("button", { name: "No" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(applied).toBe(0);
    expect(answers[0]).toMatchObject({ outcome: "declined" });
    expect((answers[0] as TemplateOfferAnswer).note).toContain(
      "Do not offer it again",
    );
  });

  test("words of the person's own go back as theirs, and nothing is applied", async () => {
    const { answers, respond } = recorder();
    const view = render(
      <OfferTemplateCard
        apply={async () => APPLIED}
        args={{ templateId: "research-desk" }}
        respond={respond}
        template={TEMPLATE}
      />,
    );
    await user.type(
      view.getByPlaceholderText("Type your own answer"),
      "Only the instructions{Enter}",
    );
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toMatchObject({
      outcome: "answered",
      text: "Only the instructions",
    });
  });

  test("a refusal stays on the card with the rows still live", async () => {
    const { answers, respond } = recorder();
    const view = render(
      <OfferTemplateCard
        apply={async () => {
          throw new Error("You do not have permission to manage this agent.");
        }}
        args={{ templateId: "research-desk" }}
        respond={respond}
        template={TEMPLATE}
      />,
    );
    await user.click(view.getByRole("button", { name: "Apply it" }));
    expect(
      await view.findByText("You do not have permission to manage this agent."),
    ).toBeTruthy();
    expect(answers).toEqual([]);
    expect(view.getByRole("button", { name: "No" })).toBeTruthy();
  });

  test("a template that is not here is answered once, without asking", async () => {
    const { answers, respond } = recorder();
    const view = render(
      <OfferTemplateCard
        apply={async () => APPLIED}
        args={{ templateId: "gone" }}
        respond={respond}
        template={null}
      />,
    );
    expect(view.getByText("That template is not here any more.")).toBeTruthy();
    await waitFor(() => expect(answers).toHaveLength(1));
    view.rerender(
      <OfferTemplateCard
        apply={async () => APPLIED}
        args={{ templateId: "gone" }}
        respond={respond}
        template={null}
      />,
    );
    await settleReactWork();
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      outcome: "unavailable",
      templateId: "gone",
    });
  });

  test("read back from its result after a reload, it is drawn answered", () => {
    const view = render(
      <OfferTemplateCard
        apply={async () => APPLIED}
        args={{ templateId: "research-desk" }}
        result={JSON.stringify({
          outcome: "declined",
          templateId: "research-desk",
          note: "",
        })}
        template={TEMPLATE}
      />,
    );
    expect(view.getByText("No")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Apply it" })).toBeNull();
    expect(readTemplateAnswer("not json")).toBeNull();
  });
});

const item = (overrides: Partial<MarketplaceItem> = {}): MarketplaceItem => ({
  id: "684",
  kind: "plugin",
  name: "Superpowers",
  summary: "Core skills library: TDD, debugging, collaboration patterns.",
  eligibility: "ready",
  skillsCount: 14,
  target: { kind: "plugin", pluginId: "684" },
  held: false,
  ...overrides,
});

const ADDED: AddedItem = {
  installed: true,
  granted: ["superpowers-test-driven-development"],
  failed: [],
};

describe("offering a Marketplace item", () => {
  test("Add installs and grants through the prop, once, and reports what is on the Bot", async () => {
    const { answers, respond } = recorder();
    let added = 0;
    let opened = 0;
    const view = render(
      <OfferMarketplaceCard
        add={async () => {
          added += 1;
          return ADDED;
        }}
        args={{ id: "684", reason: "You write code." }}
        item={item()}
        openConnect={() => {
          opened += 1;
        }}
        respond={respond}
      />,
    );
    expect(
      view.getByText(
        "Superpowers is available in the Marketplace. Add it to this Bot?",
      ),
    ).toBeTruthy();
    expect(view.getByText("It works as soon as it is added.")).toBeTruthy();
    await user.click(view.getByRole("button", { name: "Add it" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(added).toBe(1);
    expect(opened).toBe(0);
    const answer = answers[0] as MarketplaceOfferAnswer;
    expect(answer).toMatchObject({
      outcome: "added",
      id: "684",
      installed: true,
      granted: ["superpowers-test-driven-development"],
    });
    expect(answer.note).toContain("installed");
  });

  test("an optional item says connecting an account later unlocks more", async () => {
    const { answers, respond } = recorder();
    const view = render(
      <OfferMarketplaceCard
        add={async () => ADDED}
        args={{ id: "9", reason: "Fits." }}
        item={item({ id: "9", name: "Linear", eligibility: "optional" })}
        openConnect={() => {}}
        respond={respond}
      />,
    );
    expect(
      view.getByText(
        "Its skills work as soon as it is added. Connecting an account to it later in the Marketplace unlocks more.",
      ),
    ).toBeTruthy();
    await user.click(view.getByRole("button", { name: "Add it" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect((answers[0] as MarketplaceOfferAnswer).note).toContain(
      "connecting an account",
    );
  });

  test("an item that needs an account opens the page to connect it and is never added", async () => {
    const { answers, respond } = recorder();
    let added = 0;
    let opened = 0;
    const view = render(
      <OfferMarketplaceCard
        add={async () => {
          added += 1;
          return ADDED;
        }}
        args={{ id: "notion", reason: "Your notes live there." }}
        item={item({
          id: "notion",
          name: "Notion",
          eligibility: "needs-account",
          skillsCount: 0,
          target: { kind: "account", serverId: "notion" },
        })}
        openConnect={() => {
          opened += 1;
        }}
        respond={respond}
      />,
    );
    expect(
      view.getByText("Notion is available in the Marketplace."),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add it" })).toBeNull();
    await user.click(view.getByRole("button", { name: "Open to connect" }));
    await waitFor(() => expect(opened).toBe(1));
    expect(added).toBe(0);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      outcome: "connect-offered",
      id: "notion",
    });
    expect((answers[0] as MarketplaceOfferAnswer).note).toContain(
      "offered the page where they connect Notion",
    );
  });

  test("No reports the decline and adds nothing", async () => {
    const { answers, respond } = recorder();
    let added = 0;
    const view = render(
      <OfferMarketplaceCard
        add={async () => {
          added += 1;
          return ADDED;
        }}
        args={{ id: "684", reason: "Fits." }}
        item={item()}
        openConnect={() => {}}
        respond={respond}
      />,
    );
    await user.click(view.getByRole("button", { name: "No" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(added).toBe(0);
    expect(answers[0]).toMatchObject({
      outcome: "declined",
      name: "Superpowers",
    });
  });

  test("an item already on the Bot is answered once, without asking", async () => {
    const { answers, respond } = recorder();
    const view = render(
      <OfferMarketplaceCard
        add={async () => ADDED}
        args={{ id: "684", reason: "Fits." }}
        item={item({ held: true })}
        openConnect={() => {}}
        respond={respond}
      />,
    );
    expect(view.getByText("Superpowers is already on this Bot.")).toBeTruthy();
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual(marketplaceAnswer.unavailable("684", true));
  });

  test("where Open to connect goes: the plugin's page, or the account's", () => {
    expect(
      connectPageFor(item({ target: { kind: "plugin", pluginId: "7" } })),
    ).toEqual({
      to: "/marketplace",
      search: { tab: "apps", plugin: "7" },
    });
    expect(
      connectPageFor(
        item({ target: { kind: "account", serverId: "composio-gmail" } }),
      ),
    ).toEqual({
      to: "/settings/connected-accounts/$key",
      params: { key: "composio-gmail" },
    });
    expect(readMarketplaceAnswer(JSON.stringify({ outcome: "added" }))).toEqual(
      {
        outcome: "added",
      } as MarketplaceOfferAnswer,
    );
  });
});

describe("in Greek", () => {
  test("both cards speak the person's language", async () => {
    await i18n.changeLanguage("el");
    const template = render(
      <OfferTemplateCard
        apply={async () => APPLIED}
        args={{ templateId: "research-desk" }}
        respond={async () => {}}
        template={TEMPLATE}
      />,
    );
    expect(
      template.getByText("Να εφαρμοστεί το πρότυπο Research Desk;"),
    ).toBeTruthy();
    expect(template.getByRole("button", { name: "Εφάρμοσέ το" })).toBeTruthy();
    expect(template.getByRole("button", { name: "Όχι" })).toBeTruthy();
    template.unmount();

    const offer = render(
      <OfferMarketplaceCard
        add={async () => ADDED}
        args={{ id: "notion", reason: "" }}
        item={item({
          name: "Notion",
          eligibility: "needs-account",
          target: { kind: "account", serverId: "notion" },
        })}
        openConnect={() => {}}
        respond={async () => {}}
      />,
    );
    expect(
      offer.getByText("Το Notion είναι διαθέσιμο στην Αγορά."),
    ).toBeTruthy();
    expect(
      offer.getByRole("button", { name: "Άνοιγμα για σύνδεση" }),
    ).toBeTruthy();
  });
});
