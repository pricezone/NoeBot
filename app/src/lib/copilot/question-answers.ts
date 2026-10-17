import type { Message } from "@ag-ui/core";
import { isStandIn, QUESTION_TOOLS } from "./repair-history";

/** The tool a Bot asks a person with. Its server-side name; see `server/src/agents/escalation.ts`. */
const ASK_PERSON = "ask_person";

/** A user message's words, from a plain string or the text parts of an array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
        ? part.text
        : "",
    )
    .join(" ")
    .trim();
}

/**
 * What the person said after each question a Bot put to them, by the question's tool call id.
 *
 * An `ask_person` call ends the Bot's turn, so its answer is whatever the person says next: the
 * first user message with words in it after the call, whether they picked an option on the card or
 * typed into the composer. Every question still open at that message is answered by it.
 *
 * A decision card (`askChoice`, `askApproval`) is answered by its tool result when it was answered
 * on the card. One with no real result — answerable only by message, because the tab that held its
 * run is gone — is answered by the next message the same way. The stand-in result written for it
 * when that message went out is not an answer, so it does not close the question.
 *
 * Pure, so the rule is testable without a conversation, and returning a fresh map each time: the
 * caller keeps one identity per distinct content (see `channel-chat.tsx`).
 */
export function questionAnswers(
  messages: readonly Message[],
): Map<string, string> {
  const answers = new Map<string, string>();
  let open: string[] = [];
  /** Decision cards, whose real result is their answer; `ask_person`'s result only says it was put. */
  const decisions = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of Array.isArray(message.toolCalls)
        ? message.toolCalls
        : []) {
        const name = call?.function?.name ?? "";
        if (!QUESTION_TOOLS.has(name)) continue;
        open.push(call.id);
        if (name !== ASK_PERSON) decisions.add(call.id);
      }
      continue;
    }
    if (message.role === "tool") {
      const id = "toolCallId" in message ? message.toolCallId : undefined;
      // Answered on the card: its own result holds the answer, and the next message is not one.
      if (id && decisions.has(id) && !isStandIn(message.content))
        open = open.filter((waiting) => waiting !== id);
      continue;
    }
    if (message.role !== "user" || open.length === 0) continue;
    const said = textOf(message.content);
    if (!said) continue;
    for (const id of open) answers.set(id, said);
    open = [];
  }
  return answers;
}

/** The question an `ask_person` call asked, from its arguments, or nothing when they say none. */
function questionOf(args: unknown): string {
  if (typeof args !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(args || "{}");
    return parsed &&
      typeof parsed === "object" &&
      "question" in parsed &&
      typeof parsed.question === "string"
      ? parsed.question.trim()
      : "";
  } catch {
    return "";
  }
}

/**
 * The questions still waiting on the person at the end of these messages: `ask_person` calls with
 * no message from them after. Whatever they send next answers these, which is what lets the
 * conversation tell the server they are answered.
 */
export function openQuestions(
  messages: readonly Message[],
): { toolCallId: string; question: string }[] {
  let open: { toolCallId: string; question: string }[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of Array.isArray(message.toolCalls)
        ? message.toolCalls
        : []) {
        if (call?.function?.name !== ASK_PERSON) continue;
        const question = questionOf(call.function.arguments);
        if (question) open.push({ toolCallId: call.id, question });
      }
      continue;
    }
    if (message.role === "user" && textOf(message.content)) open = [];
  }
  return open;
}

/**
 * What a message the person sends now answers: the questions open at the end of the transcript,
 * and the ones still waiting on them in this conversation's thread on the server.
 *
 * The second half is for a transcript that does not hold the question yet. A new Bot's first turn
 * runs on the server, and a person who answers the moment its card appears can send before that
 * turn is in this tab's messages; the question was then never recorded as answered, and the
 * conversation kept offering it again under the reply. Same words, same question: listed once.
 */
export function questionsAnswered(
  open: readonly { question: string }[],
  waiting: readonly { threadId?: string | null; question: string }[],
  threadId: string,
): { question: string }[] {
  const seen = new Set<string>();
  const answered: { question: string }[] = [];
  for (const question of [
    ...open.map((entry) => entry.question),
    ...waiting
      .filter((entry) => entry.threadId === threadId)
      .map((entry) => entry.question),
  ]) {
    const words = question.trim();
    if (!words || seen.has(words)) continue;
    seen.add(words);
    answered.push({ question: words });
  }
  return answered;
}

/** One string per distinct set of answers, so a caller can keep a map's identity while it holds. */
export function answersSignature(answers: ReadonlyMap<string, string>): string {
  return JSON.stringify([...answers]);
}
