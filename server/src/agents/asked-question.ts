import type { Message } from "@ag-ui/client";
import { PUT_TO } from "../../../shared/handoff-markers";
import { ESCALATE_TOOL } from "./escalation";

/**
 * Whether a turn ended on a question put to the person, read from what the run carries.
 *
 * Apart from `question-turn.ts`, which wraps the model, so the computer-tool loop can ask this
 * without taking the model contract along with it.
 */

/** A string that is itself JSON for a string (how a tool result is often stored), unwrapped once. */
export function unwrapped(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/** Whether `ask_person`'s answer says the question reached somebody, however it was stored. */
export function questionWasPut(content: unknown): boolean {
  const text = unwrapped(content);
  return typeof text === "string" && text.trimStart().startsWith(PUT_TO);
}

/**
 * `endsOnQuestion` (`question-turn.ts`), for the AG-UI messages a run carries. A computer-tool loop that reads a
 * silent finish as a stall (`computer/headless-tools.ts`) asks this first: a turn that ended on a
 * question has said all it should.
 */
export function endsOnAskedQuestion(messages: readonly Message[]): boolean {
  const names = new Map<string, string>();
  for (const message of messages)
    if (message.role === "assistant")
      for (const call of message.toolCalls ?? [])
        names.set(call.id, call.function.name);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "tool") return false;
    if (
      names.get(message.toolCallId) === ESCALATE_TOOL &&
      questionWasPut(message.content)
    )
      return true;
  }
  return false;
}
