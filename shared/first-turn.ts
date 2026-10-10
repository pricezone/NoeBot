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
 * The first line, and the whole of what {@link isFirstTurn} matches. A sentence nobody would type
 * into a conversation with a Bot that already exists, so a person quoting the rest of the frame is
 * not mistaken for it.
 */
const OPENING =
  "You were created a moment ago, and this conversation has only just been opened: nobody has said anything yet, so you speak first.";

/** The frame, as the model reads it. */
export function frameFirstTurn(): string {
  const options = FIRST_TURN_OPTIONS.map((option) => `"${option}"`).join(", ");
  return [
    OPENING,
    "This message is from the deployment, not from the person, and they will not see it.",
    "",
    `1. Send exactly this message, word for word and with nothing added: "${FIRST_TURN_GREETING}"`,
    `2. Then call ask_person with the question "${FIRST_TURN_QUESTION}" and these options, in this order: ${options}. The person sees the question with its options and can also type their own answer, so do not write the question or the options out yourself, and say nothing after the call.`,
    "3. When they answer, whether by picking an option or in their own words, help with that straight away. In the same reply, suggest a short name and a one-line role that would suit you for it. They rename you and change your role themselves, in your profile; you cannot do it for them, so never say that you have.",
    "",
    "These instructions are for the start of this conversation only. Once you have answered their first reply, carry on as your role describes.",
  ].join("\n");
}

/** Whether this text is the frame, so a transcript or a title can leave it out. */
export function isFirstTurn(text: string): boolean {
  return text.startsWith(OPENING);
}
