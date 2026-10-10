import type { ModalNavItem } from "@/components/ui/modal-shell";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import { isHiddenFromSidebar, matchingChannels } from "./roster";

/**
 * What the sidebar's search popup lists, with no component around it.
 *
 * Three kinds of row. A Bot, which opens its newest conversation (or a new one). A Settings
 * section, by the same list the Settings modal draws. And a conversation hidden from the sidebar,
 * because hiding is meant to tidy the roster, not to lose a conversation: until somebody speaks in
 * it again the search is the one place in the app that still leads to it. Grok Bot's popup has
 * rows for its Computer and Updates settings too; Noë Bot has neither, so neither is here.
 */
export type PaletteItem =
  | { kind: "bot"; key: string; bot: AgentProfile }
  | { kind: "hidden-chat"; key: string; channel: ChannelSummary }
  | { kind: "setting"; key: string; setting: ModalNavItem };

export type PaletteGroup = {
  id: "bots" | "hidden-chats" | "settings";
  label: string;
  items: PaletteItem[];
};

/** How a setting reads in the list, and what it is found by. */
export function settingTitle(setting: ModalNavItem): string {
  return `Settings: ${setting.label}`;
}

/**
 * The two lines a Bot row draws, the way Grok Bot draws its own: a small label beside the name, and
 * a sentence about what the Bot does under it. The title is the label and the role description the
 * sentence; a Bot with only one of the two shows it as the sentence, so no row is left with a label
 * and nothing under it.
 */
export function botLines(bot: AgentProfile): {
  label: string | null;
  description: string | null;
} {
  const title = bot.title.trim();
  const role = bot.roleDescription.trim();
  return {
    label: title && role ? title : null,
    description: role || title || null,
  };
}

function includes(field: string | null | undefined, needle: string) {
  return field?.toLocaleLowerCase().includes(needle) ?? false;
}

/**
 * The popup's groups for what is typed, in the order they are drawn: Bots, hidden conversations,
 * Settings. Empty groups are left out, so the keyboard never lands on a heading with nothing under
 * it. A Bot is found by anything its row shows (name, title, role); a section by its row's own
 * words, so "settings" finds them all; a hidden conversation by what the roster would search it by.
 *
 * `isAdmin` is asked here and not left to the caller, because a row for Admin that a person
 * cannot open is a row that leads to a refusal.
 */
export function paletteGroups(input: {
  query: string;
  bots: readonly AgentProfile[] | undefined;
  channels: readonly ChannelSummary[] | undefined;
  settings: readonly ModalNavItem[];
  isAdmin: boolean;
}): PaletteGroup[] {
  const needle = input.query.trim().toLocaleLowerCase();
  const bots = (input.bots ?? []).filter(
    (bot) =>
      !needle ||
      includes(bot.name, needle) ||
      includes(bot.title, needle) ||
      includes(bot.roleDescription, needle),
  );
  const hidden = matchingChannels(
    (input.channels ?? []).filter(isHiddenFromSidebar),
    input.query,
  );
  const settings = input.settings.filter(
    (setting) =>
      (!setting.adminOnly || input.isAdmin) &&
      (!needle || includes(settingTitle(setting), needle)),
  );

  const groups: PaletteGroup[] = [
    {
      id: "bots",
      label: "Bots",
      items: bots.map((bot) => ({ kind: "bot", key: `bot:${bot.id}`, bot })),
    },
    {
      id: "hidden-chats",
      label: "Hidden chats",
      items: hidden.map((channel) => ({
        kind: "hidden-chat",
        key: `chat:${channel.id}`,
        channel,
      })),
    },
    {
      id: "settings",
      label: "Settings",
      items: settings.map((setting) => ({
        kind: "setting",
        key: `setting:${setting.id}`,
        setting,
      })),
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}
