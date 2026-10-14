import type { Message } from "@ag-ui/core";
import { activityFor } from "@/lib/computers/activity";
import { showScreen } from "@/lib/computers/screen";
import { openQuestions } from "@/lib/copilot/question-answers";
import { WAITING_TOOLS } from "./steps";

/**
 * What a conversation's own transcript says about the cards in it, for the parts of the screen that
 * must not draw them twice (`PendingRequests`), and for telling a turn that stopped half way from
 * one that is waiting on the person.
 */

/** A tool call as the transcript holds it: its tool, and the arguments it was called with. */
export type OpenCall = { name: string; args: Record<string, unknown> };

/** What this tab's transcript is drawing. */
export type LiveCalls = {
  /** Every tool call id in the transcript, answered or not. */
  ids: ReadonlySet<string>;
  /** The calls with no result yet, by id: the cards this transcript draws as still open. */
  open: ReadonlyMap<string, OpenCall>;
  /** The questions a Bot asked (`ask_person`) with nothing said after them yet, by their words. */
  questions: ReadonlySet<string>;
};

function argsOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw))
    return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Still streaming, or never valid: a call with no arguments yet.
    return {};
  }
}

/**
 * The result the runtime stores for a frontend tool while the browser is still carrying it out. It
 * is not an answer: read back by another tab mid-turn, the call it belongs to is still waiting.
 */
export function isForwardedPlaceholder(content: unknown): boolean {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (trimmed === "Forwarded to client") return true;
  try {
    return JSON.parse(trimmed) === "Forwarded to client";
  } catch {
    return false;
  }
}

/**
 * The decision cards that draw a stored placeholder as still waiting (see `decisions.tsx`), so for
 * them a placeholder leaves the call open. Every other card draws it as done, so for those the
 * server's own request is what is still drawn live.
 */
const DRAWS_PLACEHOLDER_OPEN = new Set(["askChoice", "askApproval"]);

/** The tool calls in these messages, which have no result, and which questions are still open. */
export function liveCalls(messages: readonly Message[]): LiveCalls {
  const ids = new Set<string>();
  const calls = new Map<string, OpenCall>();
  const answered = new Set<string>();
  const placeholders = new Set<string>();
  for (const message of messages as ReadonlyArray<Record<string, unknown>>) {
    if (message.role === "tool" && typeof message.toolCallId === "string") {
      if (isForwardedPlaceholder(message.content))
        placeholders.add(message.toolCallId);
      else answered.add(message.toolCallId);
    }
    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    for (const call of toolCalls as Array<Record<string, unknown>>) {
      if (typeof call?.id !== "string") continue;
      ids.add(call.id);
      const fn = call.function as
        | { name?: unknown; arguments?: unknown }
        | undefined;
      if (typeof fn?.name === "string")
        calls.set(call.id, { name: fn.name, args: argsOf(fn.arguments) });
    }
  }
  const open = new Map<string, OpenCall>();
  for (const [id, call] of calls) {
    if (answered.has(id)) continue;
    if (placeholders.has(id) && !DRAWS_PLACEHOLDER_OPEN.has(call.name))
      continue;
    open.set(id, call);
  }
  return {
    ids,
    open,
    questions: new Set(openQuestions(messages).map((open) => open.question)),
  };
}

/**
 * Whether the transcript holds this tool call with its arguments written in full. A read made while
 * the Bot is still writing them holds the call half written (a question with no options yet), which
 * is not yet the card a step that named it is waiting for.
 */
export function holdsToolCall(
  messages: readonly Message[],
  toolCallId: string,
): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const call = message.toolCalls?.find((each) => each.id === toolCallId);
    if (!call) continue;
    try {
      JSON.parse(call.function.arguments);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Whether a message says anything: text, or a tool call. A blank assistant turn says nothing. */
function saysSomething(message: Record<string, unknown>): boolean {
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)
    return true;
  const { content } = message;
  if (typeof content === "string") return content.trim() !== "";
  return Array.isArray(content) && content.length > 0;
}

/**
 * Whether the conversation ends on a tool result: the Bot called a tool, the result came back, and
 * it said nothing after it. System, reasoning and activity rows, and blank assistant turns, are not
 * "something said" and are looked past.
 */
export function endsOnToolResult(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as unknown as Record<string, unknown>;
    const { role } = message;
    if (role === "tool") return true;
    if (role === "user") return false;
    // A blank assistant turn is looked past, like system, developer, reasoning and activity rows.
    if (role === "assistant" && saysSomething(message)) return false;
  }
  return false;
}

/** Something is waiting on the person: an open card, or a question nobody has answered yet. */
export function waitingOnPerson(live: LiveCalls): boolean {
  if (live.questions.size > 0) return true;
  for (const call of live.open.values())
    if (WAITING_TOOLS[call.name] !== undefined) return true;
  return false;
}

/**
 * A turn that stopped before finishing: nothing running, the conversation ending on a tool result,
 * and nothing waiting on the person. Pure, so the rule is testable without a conversation.
 */
export function unfinishedTurn({
  messages,
  running,
}: {
  messages: readonly Message[];
  /** A run on the wire, a turn in this tab, or one the roster says the server is running. */
  running: boolean;
}): boolean {
  if (running || !endsOnToolResult(messages)) return false;
  return !waitingOnPerson(liveCalls(messages));
}

/** The browsing steps that mean the Bot's browser was used (see `browsing-steps.ts`). */
const BROWSING = new Set(["page", "click", "type", "sign_in", "issue"]);

/** Whether this Bot's browser was used since a moment, by this tab's own record of its steps. */
export function browsedSince(botId: string, since: number): boolean {
  return activityFor(botId).some(
    (entry) => entry.at >= since && BROWSING.has(entry.kind),
  );
}

/** Questions this tab has already taken a picture for, so one question gets one picture. */
const screened = new Set<string>();

/**
 * Take a picture of the Bot's screen for a question asked in a turn that used the browser, once.
 *
 * The question card then shows it above its options (`QuestionScreen`), in every tab and after a
 * reload, because it is kept on the server under the question's tool call. No model involvement:
 * the page the question is about is simply what the person sees while they decide. Called only by
 * the tab running the turn, which is the only one with a record of the turn's browsing.
 */
export function screenQuestionOnce(
  botId: string,
  toolCallId: string,
  turnStartedAt: number,
): void {
  if (screened.has(toolCallId) || !browsedSince(botId, turnStartedAt)) return;
  screened.add(toolCallId);
  void showScreen(botId, toolCallId);
}
