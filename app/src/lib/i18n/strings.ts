import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import { languageOf } from "@/components/noe-bot/anim/intent";
import { useInterfaceLocale } from "./index";

/**
 * The fixed words the chat's own cards say, in English and in Greek.
 *
 * WHY A TABLE AND NOT A LIBRARY. The app speaks two languages and only in one place: the cards a Bot
 * draws in a conversation (errors, recovery, permission prompts, status). The avatar's labels already
 * follow the person's language (`anim/catalog.ts`), and a Greek conversation whose every card said
 * "Retry" and "Expired" read as two products stitched together. A typed object per language is the
 * whole need: the compiler holds the Greek table to the English one, so a key cannot go missing.
 *
 * WHICH LANGUAGE IS THE PERSON'S, read from their last message with the avatar's own rule
 * (`languageOf`: Greek script anywhere means Greek), so the cards and the character beside them never
 * disagree. Nothing here is a setting; a person who switches language mid-conversation is answered in
 * the new one from their next message on.
 *
 * "Bot", never "assistant": the product calls it a Bot everywhere else.
 */

export type UiLanguage = "en" | "el";

export type WaitingKind =
  | "sign-in"
  | "code"
  | "takeover"
  | "approval"
  | "choice"
  | "other";

const EN = {
  // Recovery actions. One word or two each, so a row of them reads as a row of pills.
  retry: "Retry",
  resume: "Resume",
  continue: "Continue",
  takeOver: "Take over",
  askAgain: "Ask again",
  openScreen: "Open screen",
  stopWaiting: "Stop waiting",
  dismiss: "Dismiss",
  discard: "Discard",
  tryAgain: "Try again",

  // A turn that did not happen, or did not finish.
  sendFailed: "Your message wasn't sent.",
  sendFailedDetail: "Your words are back in the box.",
  unfinishedTurn: "The Bot stopped before finishing",
  /** What Continue says as the person, to a Bot whose turn ended mid-task. */
  continueMessage: "Continue",
  /** What Try again says as the person, after a permission was granted. */
  tryAgainMessage: "Try again",

  // A browser task left waiting on a handoff (handoff-resume-notice.tsx).
  pausedTask: "A browser task is paused here.",
  pausedTaskDetail:
    "Resume when you are ready and the Bot picks up where it stopped.",
  pausedWaiting: "Waiting for the browser handoff to finish.",

  // A card that threw while drawing (tool-boundary.tsx).
  renderCrash: (name: string) => `${name} could not be drawn.`,
  renderCrashDetail: "The rest of this conversation is unaffected.",

  // Notices about the conversation itself.
  voiceChatsUnavailable: "Voice chats couldn't be loaded.",

  // Secure forms (secure-form.tsx) and the requests drawn with them.
  secureForm: "Secure Form",
  open: "Open",
  preparing: "Preparing…",
  submitted: "Submitted",
  expired: "Expired",
  cancelled: "Cancelled",
  notCompleted: "Not completed",
  sending: "Sending…",
  decline: "Decline",
  lockNote: (host?: string) =>
    host
      ? `Never shown to your Bot. Filled directly to ${host}.`
      : "Never shown to your Bot. Filled directly into the page.",
  showValue: (label: string) => `Show ${label}`,
  hideValue: (label: string) => `Hide ${label}`,
  aValue: "A value",

  // Why a one-value request (SecretCard) ended without the value.
  secretExpired: "Nobody entered it in time, so the Bot stopped waiting.",
  secretCancelled: "The request was cancelled, so nothing was typed.",
  secretDeclined: "You declined, so nothing was typed.",
  secretFieldGone: "The field had gone from the page, so nothing was typed.",
  secretNotCompleted: "Nothing was typed into the page.",
  askAgainForCode: "Ask me again for the code",
  askAgainForValue: (label: string) => `Ask me again for ${label}`,

  // A request to take over the browser (HelpCard).
  takeOverBrowser: "Take over the browser",
  handedBack: "Handed back",
  helpDefaultTitle: "Your Bot needs you on its screen",
  nobodyTookOver: "Nobody took over before the request lapsed.",
  helpCancelled: "The request was cancelled.",
  helpStopped: "The Bot stopped waiting for you.",
  helpNotCompleted: "The takeover didn't finish.",
  askAgainToTakeOver: "Ask me again to take over",

  // The Bot's screen card (computer-view.tsx).
  botNeedsYou: "Your Bot needs you.",
  botNeedsValue: (label: string) => `Your Bot needs ${label}.`,
  answerInChat: "Answer in the chat",
  cancelRequest: "Cancel request",
  checkingControl: "Checking who has control…",
  finishingAction: "Finishing the current action…",
  youHaveControl: "You have control. Open the screen to click and type.",
  botHasControl: "Your Bot has control.",
  finishingBeforeHandover:
    "Finishing your Bot's current action before giving you control…",
  browserInterrupted: (detail?: string) =>
    `The browser was interrupted.${detail ? ` ${detail}` : ""} Open the screen and take control again to check it.`,
  computerAsleep: "Computer is asleep",
  wake: "Wake",

  // One line per tool call (tool-line.tsx).
  blocked: "Blocked",
  didNotWork: (label: string) => `${label}, didn't work`,

  // Browser steps, folded into one line (browser-activity.tsx).
  browsing: "Browsing…",
  browsedPages: (count: number) =>
    `Browsed ${count} ${count === 1 ? "page" : "pages"}`,
  browserActivity: "Browser activity",
  issues: (count: number) => `${count} ${count === 1 ? "issue" : "issues"}`,
  inProgress: "In progress",
  stepFailed: "This step could not be completed.",
  browserProblem: "The Bot ran into a problem in the browser.",
  personHadControl: "You had control, so the Bot waited.",
  pageChanged: "The page had changed, so the Bot looked again.",
  /** Step names in this language; English falls back to the group's own labels. */
  browserSteps: {} as Readonly<Record<string, string>>,

  // The status row under the last message (activity-indicator.tsx).
  waitingFor: {
    "sign-in": "Waiting for you to sign in",
    code: "Waiting for your code",
    takeover: "Waiting for you to take over",
    approval: "Waiting for your approval",
    choice: "Waiting for your answer",
    other: "Waiting for you",
  } satisfies Record<WaitingKind, string>,

  // A Team Bot asking for the person's own account (team-bot-consent.tsx).
  consentTitle: (server: string) => `Use your own ${server} account?`,
  consentAllowOnce: "Allow once",
  consentAllowAlways: "Always allow for this Bot",
  consentAllowAllTeamBots: "Always allow for all Team Bots",
  consentSkip: "Skip",
  consentSkipped: "Skipped. Nothing of yours was used.",
  consentAllowedOnce: "Allowed once.",
  consentAllowedAlways: "Always allowed for this Bot.",
  consentAllowedAllTeamBots: "Always allowed for every Team Bot.",
  /** Said after the decision where no button can ask for the person (outside a conversation). */
  consentAskYourself: (decision: "once" | "always"): string =>
    decision === "once" ? "Ask the Bot to try again." : "Ask it to try again.",

  // QuestionCard's fixed words (question-card.tsx draws them; exported here for it).
  questionOwnAnswer: "Type your own answer",
  questionOwnAnswerLabel: "Your own answer",
  questionSendAnswer: "Send answer",
  questionAnswered: "Answered",
  questionScreen: "The Bot's screen",
  // The rows of a question that can be answered with yes or no (escalation-tool.tsx).
  yes: "Yes",
  no: "No",

  // A Bot naming itself (self-profile-card.tsx).
  namedItself: (name: string) => `Named itself ${name}`,
  namingItself: "Naming itself",
  undo: "Undo",
  undoing: "Undoing…",
  undone: (name: string) => `Back to ${name}`,
  undoFailed: "That could not be undone. Try again.",

  // A decision card whose question is still being written (decisions.tsx).
  waitingForBot: "Waiting for the Bot…",
  preparingRequest: "Preparing the request…",
  preparingQuestion: "Preparing the question…",

  // The conversation screen while the server is out of reach (channel route).
  reconnecting: "Reconnecting…",
  channelLoadFailed: "Could not load this channel.",

  /** A sentence from whatever ended a turn, in this language where it is one we know. */
  reason: (sentence: string) => sentence,
};

export type UiStrings = typeof EN;

/**
 * The sentences `stopped-turn.ts` and the channel write in English, as a Greek reader should read
 * them. Anything else (a refusal's own words, a server's message) is passed through unchanged:
 * inventing a translation of a sentence nobody here wrote would be worse than showing it as written.
 */
const GREEK_REASONS: Readonly<Record<string, string>> = {
  "The conversation service did not answer, so this turn could not start. Try again in a moment.":
    "Η υπηρεσία συνομιλιών δεν απάντησε, οπότε αυτή η απάντηση δεν ξεκίνησε. Δοκίμασε ξανά σε λίγο.",
  "Another run is still in progress on this conversation. Wait for it to finish, then try again.":
    "Μια άλλη εκτέλεση βρίσκεται σε εξέλιξη σε αυτή τη συνομιλία. Περίμενε να τελειώσει και δοκίμασε ξανά.",
  "The Bot could not start this turn. Try again in a moment.":
    "Ο Bot δεν μπόρεσε να ξεκινήσει. Δοκίμασε ξανά σε λίγο.",
  "The Bot stopped without saying why.": "Ο Bot σταμάτησε χωρίς να πει γιατί.",
  "The agent is still working on another request. Please wait or stop that task first.":
    "Ο Bot δουλεύει ακόμα σε άλλο αίτημα. Περίμενε ή σταμάτησε πρώτα εκείνη την εργασία.",
  "The Bot's stream produced nothing for the configured timeout, so the turn was ended.":
    "Ο Bot δεν έστειλε τίποτα για πολλή ώρα, οπότε η απάντηση τερματίστηκε.",
  "Earlier messages are temporarily unavailable. You can keep using this conversation.":
    "Τα προηγούμενα μηνύματα δεν είναι διαθέσιμα προσωρινά. Μπορείς να συνεχίσεις τη συνομιλία.",
  "One earlier message could not be read and is not shown. The rest of this conversation is complete.":
    "Ένα προηγούμενο μήνυμα δεν διαβάστηκε και δεν εμφανίζεται. Η υπόλοιπη συνομιλία είναι πλήρης.",
  // A decision card's answer that did not leave (decisions.tsx, lib/approvals.ts).
  "Your answer could not be sent. Try again.":
    "Η απάντησή σου δεν στάλθηκε. Δοκίμασε ξανά.",
  "Your answer could not be sent.": "Η απάντησή σου δεν στάλθηκε.",
  "This question was already answered.": "Αυτή η ερώτηση έχει ήδη απαντηθεί.",
  "The answer was not sent.": "Η απάντηση δεν στάλθηκε.",
  // The channel route's own refusal (server/src/channels/routes.ts).
  "Channel not found.": "Η συνομιλία δεν βρέθηκε.",
};

const EL: UiStrings = {
  retry: "Δοκίμασε ξανά",
  resume: "Συνέχιση",
  continue: "Συνέχεια",
  takeOver: "Ανάλαβε",
  askAgain: "Ρώτα ξανά",
  openScreen: "Άνοιγμα οθόνης",
  stopWaiting: "Σταμάτα την αναμονή",
  dismiss: "Κλείσιμο",
  discard: "Απόρριψη",
  tryAgain: "Δοκίμασε ξανά",

  sendFailed: "Το μήνυμά σου δεν στάλθηκε.",
  sendFailedDetail: "Τα λόγια σου είναι πάλι στο πλαίσιο.",
  unfinishedTurn: "Ο Bot σταμάτησε πριν τελειώσει",
  continueMessage: "Συνέχισε",
  tryAgainMessage: "Δοκίμασε ξανά",

  pausedTask: "Μια εργασία στον browser έχει σταματήσει εδώ.",
  pausedTaskDetail:
    "Συνέχισε όποτε είσαι έτοιμος και ο Bot θα συνεχίσει από εκεί που σταμάτησε.",
  pausedWaiting: "Περιμένω να ολοκληρωθεί η παράδοση του browser.",

  renderCrash: (name: string) => `Το «${name}» δεν μπόρεσε να εμφανιστεί.`,
  renderCrashDetail: "Η υπόλοιπη συνομιλία δεν επηρεάζεται.",

  voiceChatsUnavailable: "Οι φωνητικές συνομιλίες δεν φορτώθηκαν.",

  secureForm: "Ασφαλής φόρμα",
  open: "Άνοιγμα",
  preparing: "Προετοιμασία…",
  submitted: "Υποβλήθηκε",
  expired: "Έληξε",
  cancelled: "Ακυρώθηκε",
  notCompleted: "Δεν ολοκληρώθηκε",
  sending: "Αποστολή…",
  decline: "Απόρριψη",
  lockNote: (host?: string) =>
    host
      ? `Δεν εμφανίζεται ποτέ στον Bot σου. Συμπληρώνεται απευθείας στο ${host}.`
      : "Δεν εμφανίζεται ποτέ στον Bot σου. Συμπληρώνεται απευθείας στη σελίδα.",
  showValue: (label: string) => `Εμφάνιση: ${label}`,
  hideValue: (label: string) => `Απόκρυψη: ${label}`,
  aValue: "Μια τιμή",

  secretExpired:
    "Κανείς δεν το συμπλήρωσε εγκαίρως, οπότε ο Bot σταμάτησε να περιμένει.",
  secretCancelled: "Το αίτημα ακυρώθηκε, οπότε δεν συμπληρώθηκε τίποτα.",
  secretDeclined: "Το αρνήθηκες, οπότε δεν συμπληρώθηκε τίποτα.",
  secretFieldGone:
    "Το πεδίο είχε φύγει από τη σελίδα, οπότε δεν συμπληρώθηκε τίποτα.",
  secretNotCompleted: "Δεν συμπληρώθηκε τίποτα στη σελίδα.",
  askAgainForCode: "Ζήτησέ μου ξανά τον κωδικό",
  askAgainForValue: (label: string) => `Ζήτησέ μου ξανά: ${label}`,

  takeOverBrowser: "Ανάλαβε τον browser",
  handedBack: "Επιστράφηκε",
  helpDefaultTitle: "Ο Bot σου σε χρειάζεται στην οθόνη του",
  nobodyTookOver: "Κανείς δεν ανέλαβε πριν λήξει το αίτημα.",
  helpCancelled: "Το αίτημα ακυρώθηκε.",
  helpStopped: "Ο Bot σταμάτησε να σε περιμένει.",
  helpNotCompleted: "Η ανάληψη δεν ολοκληρώθηκε.",
  askAgainToTakeOver: "Ζήτησέ μου ξανά να αναλάβω",

  botNeedsYou: "Ο Bot σου σε χρειάζεται.",
  botNeedsValue: (label: string) => `Ο Bot σου χρειάζεται: ${label}.`,
  answerInChat: "Απάντησε στη συνομιλία",
  cancelRequest: "Ακύρωση αιτήματος",
  checkingControl: "Έλεγχος για το ποιος έχει τον έλεγχο…",
  finishingAction: "Ολοκληρώνεται η τρέχουσα ενέργεια…",
  youHaveControl:
    "Έχεις τον έλεγχο. Άνοιξε την οθόνη για να κάνεις κλικ και να πληκτρολογήσεις.",
  botHasControl: "Ο Bot σου έχει τον έλεγχο.",
  finishingBeforeHandover:
    "Ο Bot σου ολοκληρώνει την τρέχουσα ενέργεια πριν σου δώσει τον έλεγχο…",
  browserInterrupted: (detail?: string) =>
    `Ο browser διακόπηκε.${detail ? ` ${detail}` : ""} Άνοιξε την οθόνη και πάρε ξανά τον έλεγχο για να το ελέγξεις.`,
  computerAsleep: "Ο υπολογιστής κοιμάται",
  wake: "Ξύπνα",

  blocked: "Αποκλείστηκε",
  didNotWork: (label: string) => `${label}: δεν πέτυχε`,

  browsing: "Περιήγηση…",
  browsedPages: (count: number) =>
    `Περιήγηση σε ${count} ${count === 1 ? "σελίδα" : "σελίδες"}`,
  browserActivity: "Δραστηριότητα στον browser",
  issues: (count: number) =>
    `${count} ${count === 1 ? "πρόβλημα" : "προβλήματα"}`,
  inProgress: "Σε εξέλιξη",
  stepFailed: "Αυτό το βήμα δεν ολοκληρώθηκε.",
  browserProblem: "Ο Bot συνάντησε πρόβλημα στον browser.",
  personHadControl: "Είχες τον έλεγχο, οπότε ο Bot περίμενε.",
  pageChanged: "Η σελίδα είχε αλλάξει, οπότε ο Bot κοίταξε ξανά.",
  browserSteps: {
    computer_navigate: "Άνοιξε σελίδα",
    computer_read: "Διάβασε σελίδα",
    computer_snapshot: "Εξέτασε σελίδα",
    computer_click: "Πάτησε στη σελίδα",
    computer_type: "Συμπλήρωσε πεδίο",
    computer_key: "Πάτησε πλήκτρο",
    computer_scroll: "Κύλισε σελίδα",
  },

  waitingFor: {
    "sign-in": "Σε περιμένω να συνδεθείς",
    code: "Σε περιμένω να δώσεις τον κωδικό",
    takeover: "Σε περιμένω να αναλάβεις",
    approval: "Σε περιμένω να εγκρίνεις",
    choice: "Σε περιμένω να απαντήσεις",
    other: "Σε περιμένω",
  },

  consentTitle: (server: string) =>
    `Να χρησιμοποιηθεί ο δικός σου λογαριασμός ${server};`,
  consentAllowOnce: "Να επιτραπεί μία φορά",
  consentAllowAlways: "Πάντα για αυτόν τον Bot",
  consentAllowAllTeamBots: "Πάντα για όλους τους Team Bots",
  consentSkip: "Παράλειψη",
  consentSkipped: "Παραλείφθηκε. Δεν χρησιμοποιήθηκε τίποτα δικό σου.",
  consentAllowedOnce: "Επιτράπηκε μία φορά.",
  consentAllowedAlways: "Επιτρέπεται πάντα για αυτόν τον Bot.",
  consentAllowedAllTeamBots: "Επιτρέπεται πάντα για κάθε Team Bot.",
  consentAskYourself: () => "Ζήτησε από τον Bot να δοκιμάσει ξανά.",

  questionOwnAnswer: "Γράψε τη δική σου απάντηση",
  questionOwnAnswerLabel: "Η δική σου απάντηση",
  questionSendAnswer: "Αποστολή απάντησης",
  questionAnswered: "Απαντήθηκε",
  questionScreen: "Η οθόνη του Bot",
  yes: "Ναι",
  no: "Όχι",

  namedItself: (name: string) => `Ονομάστηκε ${name}`,
  namingItself: "Διαλέγει όνομα",
  undo: "Αναίρεση",
  undoing: "Αναίρεση…",
  undone: (name: string) => `Ξανά ${name}`,
  undoFailed: "Δεν ήταν δυνατή η αναίρεση. Δοκίμασε ξανά.",

  waitingForBot: "Αναμονή για τον Bot…",
  preparingRequest: "Ετοιμάζεται το αίτημα…",
  preparingQuestion: "Ετοιμάζεται η ερώτηση…",

  reconnecting: "Επανασύνδεση…",
  channelLoadFailed: "Δεν ήταν δυνατή η φόρτωση αυτής της συνομιλίας.",

  reason: (sentence: string) => GREEK_REASONS[sentence] ?? sentence,
};

const TABLES: Readonly<Record<UiLanguage, UiStrings>> = { en: EN, el: EL };

/** The table for one language. English for anything unknown. */
export function stringsFor(language: UiLanguage | undefined): UiStrings {
  return TABLES[language ?? "en"] ?? EN;
}

/**
 * The person's language, from their last message: the avatar's rule, so the two agree. Before the
 * person has said anything, the interface's language (`fallback`), so an empty conversation's cards
 * speak the language the person chose rather than English.
 */
export function conversationLanguage(
  lastPersonText: string | null | undefined,
  fallback: UiLanguage = "en",
): UiLanguage {
  return lastPersonText?.trim() ? languageOf(lastPersonText) : fallback;
}

/** The last thing the person said, among AG-UI messages, as text. */
export function lastPersonText(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const { content } = message;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part: unknown) =>
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
            ? part.text
            : "",
        )
        .join(" ");
      if (text.trim()) return text;
    }
  }
  return null;
}

const UiLanguageContext = createContext<UiLanguage | null>(null);

/**
 * Says which language the cards under it speak. The transcript provides it from the person's last
 * message; anything drawn outside a conversation speaks the interface's language.
 */
export function UiLanguageProvider({
  language,
  children,
}: {
  language: UiLanguage;
  children: ReactNode;
}) {
  return createElement(
    UiLanguageContext.Provider,
    { value: language },
    children,
  );
}

export function useUiLanguage(): UiLanguage {
  const interfaceLocale = useInterfaceLocale();
  return useContext(UiLanguageContext) ?? interfaceLocale;
}

/** The words for the conversation this component is drawn in. */
export function useUiStrings(): UiStrings {
  return stringsFor(useUiLanguage());
}

/**
 * The language each conversation last spoke, for what is drawn beside it rather than inside it: the
 * Bot panel's screen card, and the channel screen while it reconnects. Both sit outside the
 * transcript's `UiLanguageProvider`, so a Greek conversation's panel said "Your Bot needs…" in
 * English. Noted by the conversation as its language changes and kept for the life of the tab.
 */
const notedLanguages = new Map<string, UiLanguage>();
const languageListeners = new Set<() => void>();

/** What a language is noted under: the conversation's Bot, and the conversation itself. */
export const languageKeys = {
  bot: (botId: string) => `bot:${botId}`,
  channel: (channelId: string) => `channel:${channelId}`,
};

export function noteLanguage(
  keys: readonly string[],
  language: UiLanguage,
): void {
  let changed = false;
  for (const key of keys) {
    if (notedLanguages.get(key) === language) continue;
    notedLanguages.set(key, language);
    changed = true;
  }
  if (changed) for (const listener of languageListeners) listener();
}

function subscribeToLanguages(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => {
    languageListeners.delete(listener);
  };
}

/** The language noted under `key`, or `fallback` (the interface's language) until one is. */
export function useNotedLanguage(
  key: string | undefined,
  fallbackLanguage?: UiLanguage,
): UiLanguage {
  const interfaceLocale = useInterfaceLocale();
  const fallback = fallbackLanguage ?? interfaceLocale;
  return useSyncExternalStore(
    subscribeToLanguages,
    () => (key === undefined ? undefined : notedLanguages.get(key)) ?? fallback,
    () => fallback,
  );
}

/** 2:15 for 135 seconds, 1:02:03 past the hour. */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}
