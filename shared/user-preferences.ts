import type { Locale } from "./i18n/locales";

export type MessageListEmphasis = "agent" | "thread";

/**
 * How far Clicky may go on the computer for this person.
 *
 * - `ask_each`: it may act, and asks before every action.
 * - `ask_once_per_task`: one yes covers the rest of the task's low-risk actions; anything that is hard
 *   to undo is still asked about each time.
 * - `never`: guide only. Clicky points and explains and never clicks or types.
 */
export type ClickyActionPolicy = "ask_each" | "ask_once_per_task" | "never";

/** How much Clicky says per step: one short line, or a line and the reason behind it. */
export type ClickyGuidance = "brief" | "detailed";

export type UserPreferences = {
  messageListEmphasis: MessageListEmphasis;
  /** Whether this person closed the banner offering help self-hosting OpenBot. */
  selfHostBannerDismissed: boolean;
  /**
   * The interface language this person chose. Absent or null until they choose one, which is
   * different from having chosen English: an unchosen language may still follow the deployment's
   * default or the browser, and a platform that signs them in may suggest one. Optional, and absent
   * from the defaults, so a person who never chose reads exactly as they did before languages existed.
   */
  locale?: Locale | null;
  /*
   * Clicky's preferences are flat keys rather than one object, because a save merges one level deep
   * (`preferences || patch` in Postgres): a nested object saved for one setting would wipe its
   * siblings. Optional and absent from the defaults, like `locale`, so every reader goes through
   * `clickyPreferencesOf` and nothing that predates Clicky changes shape.
   */
  /** Clicky opens by itself when the Bot needs this person on its computer. */
  clickyAutoActivate?: boolean;
  clickyActionPolicy?: ClickyActionPolicy;
  clickyGuidance?: ClickyGuidance;
  /** Clicky reads its replies aloud on the device the person is using. */
  clickySpeakReplies?: boolean;
  /** The person has seen Clicky's introduction. */
  clickyOnboarded?: boolean;
};

export type ClickyPreferences = Required<
  Pick<
    UserPreferences,
    | "clickyAutoActivate"
    | "clickyActionPolicy"
    | "clickyGuidance"
    | "clickySpeakReplies"
    | "clickyOnboarded"
  >
>;

export const DEFAULT_CLICKY_PREFERENCES: ClickyPreferences = {
  clickyAutoActivate: true,
  // Clicky may act only after the person turns "Do it for me" on, and then asks every time.
  clickyActionPolicy: "ask_each",
  clickyGuidance: "brief",
  clickySpeakReplies: false,
  clickyOnboarded: false,
};

/** This person's Clicky settings, with the defaults filled in for any they never saved. */
export function clickyPreferencesOf(
  preferences: Partial<UserPreferences> | undefined,
): ClickyPreferences {
  return {
    clickyAutoActivate:
      preferences?.clickyAutoActivate ??
      DEFAULT_CLICKY_PREFERENCES.clickyAutoActivate,
    clickyActionPolicy:
      preferences?.clickyActionPolicy ??
      DEFAULT_CLICKY_PREFERENCES.clickyActionPolicy,
    clickyGuidance:
      preferences?.clickyGuidance ?? DEFAULT_CLICKY_PREFERENCES.clickyGuidance,
    clickySpeakReplies:
      preferences?.clickySpeakReplies ??
      DEFAULT_CLICKY_PREFERENCES.clickySpeakReplies,
    clickyOnboarded:
      preferences?.clickyOnboarded ??
      DEFAULT_CLICKY_PREFERENCES.clickyOnboarded,
  };
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  // The Bot's name leads each roster row, the way a messaging app leads with who said it.
  messageListEmphasis: "agent",
  selfHostBannerDismissed: false,
};
