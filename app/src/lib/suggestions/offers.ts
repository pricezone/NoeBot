import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { grantPlugin } from "@/lib/plugins/mutations";
import type {
  MarketplaceItem,
  MarketplaceOfferAnswer,
  TemplateApplied,
  TemplateOfferAnswer,
} from "../../../../shared/suggestions";

/**
 * What the two offer cards do and what they answer, kept out of the cards so a test reaches them
 * without a DOM and so the sentence a card sends and the reader that draws it from a reload cannot
 * drift apart.
 *
 * The answers are objects the runtime serialises as the tool's result: `outcome` is what the card
 * reads back to draw itself answered, and `note` is the sentence the Bot reads, addressed to it and
 * saying what to do next — a result that only reports state leaves a Bot guessing.
 */

export type {
  MarketplaceItem,
  MarketplaceOfferAnswer,
  TemplateApplied,
  TemplateOfferAnswer,
};

const list = (items: readonly string[]) => items.join(", ");

export const templateAnswer = {
  applied: (
    templateId: string,
    template: string,
    applied: TemplateApplied,
  ): TemplateOfferAnswer => {
    const parts = [
      `The person applied the ${template} template to this Bot. It now has the template's title (${applied.title}) and instructions`,
    ];
    if (applied.avatar) parts.push("and its avatar");
    parts.push(
      applied.renamed
        ? `and is now called ${applied.name}.`
        : "and kept the name the person gave it.",
    );
    if (applied.skills.length > 0)
      parts.push(`Skills added: ${list(applied.skills)}.`);
    if (applied.failedSkills.length > 0)
      parts.push(
        `These skills could not be added: ${list(applied.failedSkills)}; say so.`,
      );
    parts.push(
      "The new instructions apply from your next turn. Tell the person in a sentence what changed, and that connecting the apps the template uses in the Marketplace unlocks more.",
    );
    return {
      outcome: "applied",
      templateId,
      applied,
      note: parts.join(" "),
    };
  },
  declined: (templateId: string, template: string): TemplateOfferAnswer => ({
    outcome: "declined",
    templateId,
    note: `The person declined the ${template} template, so nothing changed. Do not offer it again in this conversation.`,
  }),
  answered: (templateId: string, text: string): TemplateOfferAnswer => ({
    outcome: "answered",
    templateId,
    text,
    note: `The person answered in their own words instead of applying the template, so nothing changed: "${text}". Carry on from what they said.`,
  }),
  unavailable: (templateId: string): TemplateOfferAnswer => ({
    outcome: "unavailable",
    templateId,
    note: `There is no template called ${templateId} here, so nothing was offered. Do not offer it again.`,
  }),
};

export const marketplaceAnswer = {
  added: (
    item: Pick<MarketplaceItem, "id" | "name" | "eligibility">,
    outcome: AddedItem,
  ): MarketplaceOfferAnswer => {
    const parts = [`The person added ${item.name} to this Bot.`];
    if (outcome.installed)
      parts.push("It was installed in this deployment's Marketplace first.");
    if (outcome.granted.length > 0)
      parts.push(`On this Bot now: ${list(outcome.granted)}.`);
    if (outcome.failed.length > 0)
      parts.push(
        `These could not be put on this Bot: ${list(outcome.failed)}; an administrator can grant them on the Plugins screens.`,
      );
    parts.push(
      item.eligibility === "optional"
        ? "Its skills work from your next turn; tell the person that connecting an account to it in the Marketplace unlocks its connectors too."
        : "It works from your next turn. Tell the person in a sentence.",
    );
    return {
      outcome: "added",
      id: item.id,
      name: item.name,
      installed: outcome.installed,
      granted: outcome.granted,
      failed: outcome.failed,
      note: parts.join(" "),
    };
  },
  connectOffered: (
    item: Pick<MarketplaceItem, "id" | "name">,
  ): MarketplaceOfferAnswer => ({
    outcome: "connect-offered",
    id: item.id,
    name: item.name,
    note: `The person was offered the page where they connect ${item.name}, and it opened for them. Nothing was added: it works once they connect their account there. Do not offer it again in this conversation.`,
  }),
  declined: (
    item: Pick<MarketplaceItem, "id" | "name">,
  ): MarketplaceOfferAnswer => ({
    outcome: "declined",
    id: item.id,
    name: item.name,
    note: `The person declined ${item.name}, so nothing was added. Do not offer it again in this conversation.`,
  }),
  answered: (id: string, text: string): MarketplaceOfferAnswer => ({
    outcome: "answered",
    id,
    text,
    note: `The person answered in their own words instead of choosing, so nothing was added: "${text}". Carry on from what they said.`,
  }),
  unavailable: (id: string, held = false): MarketplaceOfferAnswer => ({
    outcome: "unavailable",
    id,
    note: held
      ? `${id} is already on this Bot, so nothing was offered. Use it rather than offering it.`
      : `${id} is not something the Marketplace offers here, so nothing was offered. Do not offer it again.`,
  }),
};

/** A recorded result, read back. Null for anything that is not one of these answers. */
function readOutcome(
  result: string | undefined,
): Record<string, unknown> | null {
  if (!result) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    return parsed && typeof parsed === "object" && "outcome" in parsed
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readTemplateAnswer(
  result: string | undefined,
): TemplateOfferAnswer | null {
  const parsed = readOutcome(result);
  return parsed &&
    ["applied", "declined", "answered", "unavailable"].includes(
      String(parsed.outcome),
    )
    ? (parsed as TemplateOfferAnswer)
    : null;
}

export function readMarketplaceAnswer(
  result: string | undefined,
): MarketplaceOfferAnswer | null {
  const parsed = readOutcome(result);
  return parsed &&
    [
      "added",
      "connect-offered",
      "declined",
      "answered",
      "unavailable",
    ].includes(String(parsed.outcome))
    ? (parsed as MarketplaceOfferAnswer)
    : null;
}

/* ---------------------------------------------------------------------------------------------- */
/* Server calls                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

export const suggestionKeys = {
  item: (id: string, agentId: string) =>
    ["suggestions", "marketplace", agentId, id] as const,
};

/** One Marketplace item as this deployment describes it, for the Bot it is offered to. */
export function marketplaceItemQueryOptions(id: string, agentId: string) {
  return queryOptions({
    queryKey: suggestionKeys.item(id, agentId),
    enabled: id.length > 0 && agentId.length > 0,
    retry: false,
    queryFn: async (): Promise<MarketplaceItem | null> => {
      try {
        return await client<MarketplaceItem>(
          `/api/suggestions/marketplace/${encodeURIComponent(id)}?agentId=${encodeURIComponent(agentId)}`,
          "item",
          { fallback: "That Marketplace item could not be read." },
        );
      } catch (error) {
        // Not offered here is an answer, not a failure: the card says so and moves on.
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },
  });
}

/** Apply a template to an existing Bot. The server decides who may and records it. */
export async function applyTemplate(
  templateId: string,
  agentId: string,
): Promise<TemplateApplied> {
  return client<TemplateApplied>(
    `/api/bot-templates/${encodeURIComponent(templateId)}/apply/${encodeURIComponent(agentId)}`,
    "applied",
    {
      method: "POST",
      body: {},
      fallback: "The template could not be applied.",
    },
  );
}

/** What adding an item did: whether it was installed first, and what is on the Bot now. */
export type AddedItem = {
  installed: boolean;
  granted: string[];
  failed: string[];
};

type InstalledPlugin = {
  created: boolean;
  skills: { slug: string; offeredToAllBots: boolean; grantedTo: string[] }[];
};

/**
 * Add an item to a Bot through the routes the Marketplace itself uses.
 *
 * A plugin is installed (or found installed) with `POST /api/plugins/install`, which offers its
 * parts to every Bot; a skill an administrator has narrowed away from this Bot is then granted with
 * `POST /api/plugins/grants`, one at a time, and one that is refused is reported rather than failing
 * the rest. A skill of the deployment is granted directly. Never called for an item that needs an
 * account: that card sends the person to connect it instead.
 */
export async function addMarketplaceItem(
  item: Pick<MarketplaceItem, "target">,
  agentId: string,
): Promise<AddedItem> {
  const { target } = item;
  if (target.kind === "skill") {
    await grantPlugin({ kind: "skill", ref: target.slug, agentId });
    return { installed: false, granted: [target.slug], failed: [] };
  }
  if (target.kind !== "plugin") {
    throw new Error("This one is connected from its own page, not added here.");
  }
  const response = await client("/api/plugins/install", {
    method: "POST",
    body: { pluginId: target.pluginId },
    fallback: "That plugin could not be added.",
  });
  const installed = (await response.json()) as InstalledPlugin;
  const outcome: AddedItem = {
    installed: installed.created,
    granted: [],
    failed: [],
  };
  for (const skill of installed.skills) {
    if (skill.offeredToAllBots || skill.grantedTo.includes(agentId)) {
      outcome.granted.push(skill.slug);
      continue;
    }
    try {
      await grantPlugin({ kind: "skill", ref: skill.slug, agentId });
      outcome.granted.push(skill.slug);
    } catch {
      outcome.failed.push(skill.slug);
    }
  }
  return outcome;
}

/** Where "Open to connect" goes: the plugin's page in the Marketplace, or the account's page. */
export type ConnectPage =
  | {
      to: "/marketplace";
      search: { tab: "apps"; plugin: string } | { tab: "skills" };
    }
  | { to: "/settings/connected-accounts/$key"; params: { key: string } };

export function connectPageFor(
  item: Pick<MarketplaceItem, "target">,
): ConnectPage {
  const { target } = item;
  if (target.kind === "account") {
    return {
      to: "/settings/connected-accounts/$key",
      params: { key: target.serverId },
    };
  }
  return target.kind === "plugin"
    ? { to: "/marketplace", search: { tab: "apps", plugin: target.pluginId } }
    : { to: "/marketplace", search: { tab: "skills" } };
}
