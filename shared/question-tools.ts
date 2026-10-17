/**
 * The tools that put a question to the person, and the stand-in results written for them.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `handoff-markers.ts` gives. The browser
 * decides which message answers a question (`app/src/lib/copilot/question-answers.ts`) and repairs a
 * history whose card was never answered (`repair-history.ts`); the server reads the same rule to tell
 * the model which message is an answer, and to end a run once a question is waiting. A stand-in
 * reworded on one side only would read as a real answer on the other.
 */

/**
 * `ask_person` on the server, and the two decision cards that suspend a run in the browser. A card
 * is answered on the card where the tab that drew it still holds the run; anywhere else (another
 * tab, or the same one after a reload) the only way left to answer it is the next message, so that
 * message is the answer.
 */
export const QUESTION_TOOLS: ReadonlySet<string> = new Set([
  "ask_person",
  "askChoice",
  "askApproval",
]);

/** The result written for a call whose surface was interrupted before it could answer. */
export const UNANSWERED =
  "This call produced no result: the surface was interrupted before it could answer. Do not assume it succeeded.";

/**
 * The stand-in for a question nobody answered on its card, when the person has written since. It
 * tells the Bot where the answer is instead of that the question failed, which is what the generic
 * sentence above would have it believe.
 */
export const ANSWERED_IN_CHAT =
  "The person answered this question in their next message instead of on the card. Read that message as their answer.";

/** Whether a tool result is one of the stand-ins above rather than a real answer. */
export function isStandIn(content: unknown): boolean {
  return content === UNANSWERED || content === ANSWERED_IN_CHAT;
}
