/**
 * The message a brand-new Bot's first turn is sent as, declared once and read from both sides.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `routine-firing.ts` gives. "Create new Bot"
 * in the To: menu makes a Bot and opens a conversation with it, and the Bot speaks first: the server
 * runs one headless turn whose user message is this frame, and that turn persists it to the
 * transcript like any other. Nobody typed it, so the browser has to recognise it again to leave it
 * out of what a person reads, and the summary sweep has to recognise it to keep it out of the
 * conversation's title.
 *
 * WHY A MESSAGE AND NOT THE BOT'S PROMPT. The instructions are for the start of one conversation.
 * Written into the role they would greet the person again in every channel, for ever; sent as this
 * turn's message they are history in this one conversation and nowhere else, which is also what
 * lets the Bot's second turn — the person's answer — still read what it was asked to do with it.
 */

import type { Locale } from "./i18n/locales";
import { SELF_PROFILE_TOOL } from "./self-profile";

/** What the Bot says first, word for word. */
export const FIRST_TURN_GREETING =
  "Hi! I'm New Bot, and I'm glad to be here. I'd love to figure out where I can actually take something off your plate.";

/** The question it then puts to the person through `ask_person`. */
export const FIRST_TURN_QUESTION = "What do you mainly want help with?";

/** The answers offered with it, in the order they are shown. The person can type their own. */
export const FIRST_TURN_OPTIONS = [
  "Research and writing",
  "Code and GitHub work",
  "Web tasks and errands",
  "Recurring checks and reminders",
] as const;

/**
 * What the person reads, in the language their interface speaks: the new Bot's name and title, its
 * greeting, the question and its answers. The frame around them stays English, because the model
 * reads it; only the words the person sees change.
 */
export const FIRST_TURN_COPY: Record<
  Locale,
  {
    name: string;
    title: string;
    greeting: string;
    question: string;
    options: readonly string[];
  }
> = {
  en: {
    name: "New Bot",
    title: "General assistant",
    greeting: FIRST_TURN_GREETING,
    question: FIRST_TURN_QUESTION,
    options: FIRST_TURN_OPTIONS,
  },
  el: {
    name: "Νέος Bot",
    title: "Γενικός βοηθός",
    greeting:
      "Γεια! Είμαι ο Νέος Bot και χαίρομαι που είμαι εδώ. Θα ήθελα πολύ να βρω πού μπορώ πραγματικά να σου ξαλαφρώσω το πρόγραμμα.",
    question: "Σε τι θέλεις κυρίως βοήθεια;",
    options: [
      "Έρευνα και γραφή",
      "Κώδικας και GitHub",
      "Εργασίες στο web και θελήματα",
      "Επαναλαμβανόμενοι έλεγχοι και υπενθυμίσεις",
    ],
  },
};

/**
 * The first line, and the whole of what {@link isFirstTurn} matches. A sentence nobody would type
 * into a conversation with a Bot that already exists, so a person quoting the rest of the frame is
 * not mistaken for it.
 */
const OPENING =
  "You were created a moment ago, and this conversation has only just been opened: nobody has said anything yet, so you speak first.";

/** A whole word and its cut-off form, in the language the person reads, for the naming rule. */
const WHOLE_WORD: Record<Locale, { whole: string; cut: string }> = {
  en: { whole: "Coordinator", cut: "Coord." },
  el: { whole: "Διεκπεραιωτής", cut: "Διεκπ." },
};

/**
 * The frame, as the model reads it, with the words the person sees in their language.
 *
 * TWO TURNS, NOT ONE. The question ends this turn (`ask_person` stops the run once it is put), and
 * everything after it waits for the person's answer, which arrives as their next message: helping
 * with it, naming itself for it, and suggesting a ready-made Bot or a plugin. Asked to do those in
 * the same turn as the question, a model answered its own question before the person could.
 */
export function frameFirstTurn(locale: Locale = "en"): string {
  const copy = FIRST_TURN_COPY[locale];
  const options = copy.options.map((option) => `"${option}"`).join(", ");
  const word = WHOLE_WORD[locale];
  return [
    OPENING,
    "This message is from the deployment, not from the person, and they will not see it.",
    "",
    `1. Send exactly this message, word for word and with nothing added: "${copy.greeting}"`,
    `2. Then call ask_person with the question "${copy.question}" and these options, in this order: ${options}. The person sees the question with its options and can also type their own answer, so do not write the question or the options out yourself. The call ends your turn: do nothing else until they answer.`,
    `3. Only once their answer arrives, as their next message, whether they picked an option or wrote their own words: help with that straight away. In the same reply, call ${SELF_PROFILE_TOOL} with a name and a one-line role that suit you for it. The name is one or two whole words in the person's language, never abbreviated or cut short (write "${word.whole}", never "${word.cut}"); the role is one line.${locale === "el" ? " Write it all in Greek, unless they answer in another language." : ""} If ${SELF_PROFILE_TOOL} refuses, follow what it says; if you do not have it, suggest the name and role instead and say they can change them in your profile.`,
    "4. Then, if you have them and it would help: call find_bot_templates and, for a good fit, offer_bot_template, to suggest a ready-made Bot for this kind of work; and call find_marketplace_items and, for a good fit, offer_marketplace_item, to suggest a plugin or app that would help. Skip any you do not have.",
    "",
    "These instructions are for the start of this conversation only. Once you have answered their first reply, carry on as your role describes.",
  ].join("\n");
}

/** Whether this text is the frame, so a transcript or a title can leave it out. */
export function isFirstTurn(text: string): boolean {
  return text.startsWith(OPENING);
}
