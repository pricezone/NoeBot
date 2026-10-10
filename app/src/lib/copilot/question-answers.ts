import type { Message } from "@ag-ui/core";

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
 * Pure, so the rule is testable without a conversation, and returning a fresh map each time: the
 * caller keeps one identity per distinct content (see `channel-chat.tsx`).
 */
export function questionAnswers(
  messages: readonly Message[],
): Map<string, string> {
  const answers = new Map<string, string>();
  let open: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of Array.isArray(message.toolCalls)
        ? message.toolCalls
        : []) {
        if (call?.function?.name === ASK_PERSON) open.push(call.id);
      }
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

/** One string per distinct set of answers, so a caller can keep a map's identity while it holds. */
export function answersSignature(answers: ReadonlyMap<string, string>): string {
  return JSON.stringify([...answers]);
}
