/**
 * Suggesting a Bot template or a Marketplace item from inside a conversation.
 *
 * Two halves that have to agree: the server finds (`find_bot_templates`, `find_marketplace_items`,
 * run where the Bot runs) and the browser offers (`offer_bot_template`, `offer_marketplace_item`,
 * cards that wait on the person). The names, the item shape and the answers a card sends back are
 * declared once, here, so neither side can rename a field the other reads.
 */

import { FIRST_TURN_COPY } from "./first-turn";

export const FIND_BOT_TEMPLATES_TOOL = "find_bot_templates";
export const OFFER_BOT_TEMPLATE_TOOL = "offer_bot_template";
export const FIND_MARKETPLACE_ITEMS_TOOL = "find_marketplace_items";
export const OFFER_MARKETPLACE_ITEM_TOOL = "offer_marketplace_item";

/** How many matches each finder answers with, at most. */
export const TEMPLATE_MATCHES = 5;
export const MARKETPLACE_MATCHES = 6;

/** One template as `find_bot_templates` answers it. `score` is 0 to 1, higher is closer. */
export type TemplateMatch = {
  id: string;
  name: string;
  title: string;
  summary: string;
  score: number;
};

/**
 * What adding an item does for a Bot right now.
 *
 * - `ready`: everything works once added (no connector, or connectors that need no account).
 * - `optional`: its skills work once added; connecting an account later unlocks its connectors.
 * - `needs-account`: nothing works until the person connects an account, so it is never added
 *   from the chat; the person is sent to the page where they connect it.
 */
export type MarketplaceEligibility = "ready" | "optional" | "needs-account";

/** One item as `find_marketplace_items` answers it. */
export type MarketplaceMatch = {
  id: string;
  kind: "plugin" | "skill";
  name: string;
  summary: string;
  eligibility: MarketplaceEligibility;
  skillsCount: number;
};

/**
 * Where an item comes from, which decides what "Add it" and "Open to connect" do.
 *
 * `plugin` is a Marketplace plugin (installed, then its skills granted); `skill` is a skill of this
 * deployment granted directly; `account` is an app reached with the person's own account (a
 * catalogue app or a Composio app), connected on its Connected accounts page.
 */
export type MarketplaceTarget =
  | { kind: "plugin"; pluginId: string }
  | { kind: "skill"; slug: string }
  | { kind: "account"; serverId: string };

/** One item as the offer card reads it: the match, where it comes from, and whether it is here. */
export type MarketplaceItem = MarketplaceMatch & {
  target: MarketplaceTarget;
  /** Already on this Bot: nothing to add, so the card says so instead of asking. */
  held: boolean;
};

/** What applying a template changed on the Bot. */
export type TemplateApplied = {
  name: string;
  renamed: boolean;
  title: string;
  instructions: boolean;
  avatar: boolean;
  skills: string[];
  failedSkills: string[];
};

/** The answer `offer_bot_template` resumes the Bot with. `note` is the sentence the Bot reads. */
export type TemplateOfferAnswer =
  | {
      outcome: "applied";
      templateId: string;
      applied: TemplateApplied;
      note: string;
    }
  | { outcome: "declined"; templateId: string; note: string }
  | { outcome: "answered"; templateId: string; text: string; note: string }
  | { outcome: "unavailable"; templateId: string; note: string };

/** The answer `offer_marketplace_item` resumes the Bot with. */
export type MarketplaceOfferAnswer =
  | {
      outcome: "added";
      id: string;
      name: string;
      installed: boolean;
      granted: string[];
      failed: string[];
      note: string;
    }
  | { outcome: "connect-offered"; id: string; name: string; note: string }
  | { outcome: "declined"; id: string; name: string; note: string }
  | { outcome: "answered"; id: string; text: string; note: string }
  | { outcome: "unavailable"; id: string; note: string };

/**
 * The names a Bot made in one click starts with, in every language. A Bot still called one of
 * these takes a template's name when the template is applied; any other name is the person's.
 */
export const DEFAULT_BOT_NAMES: ReadonlySet<string> = new Set(
  Object.values(FIRST_TURN_COPY).map((copy) => copy.name),
);

export function hasDefaultBotName(name: string): boolean {
  return DEFAULT_BOT_NAMES.has(name.trim());
}
