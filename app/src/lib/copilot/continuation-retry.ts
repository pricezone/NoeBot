import type { Message } from "@ag-ui/core";
import { i18n, msg } from "@/lib/i18n";
import { asText } from "@/lib/plugins/tool-result";
import { PUT_TO } from "./markers";
import { isStandIn } from "./repair-history";

/**
 * A browser step followed by silence, retried once and then reported.
 *
 * A turn that touches the browser is several runs: the Bot asks for a click, the run ends, the
 * browser clicks, and a continuation run carries the result back. When that continuation failed or
 * came back with nothing, the turn simply ended: the status said "Done", there was no answer, and
 * nothing said anything had gone wrong. Worse, its failure was never reported at all, because the
 * screen stops listening for failures when the FIRST run of the turn finishes.
 *
 * So after the whole turn has come back: if it ends on a tool result this turn produced (the
 * browser answered and nobody spoke after it) the continuation is started once more with the same
 * conversation; if that also ends there, the turn is a failure with a sentence, which the screen
 * shows and which puts the person's words back for them to send again.
 */

/** What the person is told when the retried continuation also came back with nothing. */
export const SILENT_CONTINUATION = msg(
  "The Bot stopped after a browser step without answering. Send your message again to continue.",
);

type Subscriber = {
  onRunErrorEvent?: (params: { event?: { message?: string } }) => void;
  onRunFailed?: (params: { error: unknown }) => void;
};

export type ContinuedAgent = {
  messages: Message[];
  subscribe(subscriber: Subscriber): { unsubscribe(): void };
};

const PLACEHOLDER = "Forwarded to client";

/**
 * Whether a result leaves a question waiting on the person, which ends the Bot's turn: running the
 * model again on it would have the Bot answer its own question.
 *
 * `ask_person` put to them ("Put to …"). A decision card (`askChoice`, `askApproval`) whose result
 * is only a stand-in or the runtime's placeholder. A card answered on the card is not waiting: its
 * follow-up is the Bot reading the answer, and one that failed or came back empty is retried.
 */
function questionWaiting(toolName: string, content: unknown): boolean {
  const text = typeof content === "string" ? asText(content).trim() : "";
  if (toolName === "ask_person") return text.startsWith(PUT_TO);
  if (toolName !== "askChoice" && toolName !== "askApproval") return false;
  return isStandIn(text) || text === PLACEHOLDER;
}

/**
 * Whether the conversation ends on a tool result this turn added, for a tool whose result is meant
 * to be followed by the Bot: the browser answered, and the continuation never came. Never when the
 * turn ended on a question still waiting on the person (`questionWaiting`).
 */
export function awaitsContinuation(
  messages: readonly Message[],
  before: ReadonlySet<string>,
  followsUp: (toolName: string) => boolean,
): boolean {
  const last = messages.at(-1);
  if (last?.role !== "tool" || before.has(last.id)) return false;
  const content = typeof last.content === "string" ? last.content.trim() : "";
  if (content === PLACEHOLDER || content === JSON.stringify(PLACEHOLDER))
    return false;
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []) : [],
  );
  const nameOf = (id: string) =>
    calls.find((candidate) => candidate.id === id)?.function.name;
  // A waiting question among the results the turn ended on ends it, whichever of them came last.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "tool") break;
    if (
      questionWaiting(nameOf(message.toolCallId) ?? "", message.content ?? "")
    )
      return false;
  }
  const name = nameOf(last.toolCallId);
  return Boolean(name && followsUp(name));
}

function isAbort(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error);
  return (
    (error instanceof Error && error.name === "AbortError") ||
    text.includes("aborted") ||
    text === "component unmounted"
  );
}

/**
 * Run the turn, and the continuation once more if it ended after a browser step in silence.
 *
 * Answers the sentence to fail the turn with, or null when it finished (or the person stopped it).
 * A first run that failed before any browser step is not this function's to report: the screen's
 * own failure path already has it.
 */
export async function runWithContinuationRetry(options: {
  agent: ContinuedAgent;
  run: () => Promise<unknown>;
  /** The conversation's message ids before this turn. */
  before: ReadonlySet<string>;
  followsUp: (toolName: string) => boolean;
  /** Whether the person stopped the turn since it started. */
  stopped: () => boolean;
}): Promise<string | null> {
  const errors: string[] = [];
  const subscription = options.agent.subscribe({
    onRunErrorEvent: ({ event }) => {
      if (event?.message) errors.push(event.message);
    },
    onRunFailed: ({ error }) => {
      if (!isAbort(error))
        errors.push(String(error instanceof Error ? error.message : error));
    },
  });
  try {
    await options.run();
    const stalled = () =>
      !options.stopped() &&
      awaitsContinuation(
        options.agent.messages,
        options.before,
        options.followsUp,
      );
    if (!stalled()) return null;
    errors.length = 0;
    await options.run();
    if (!stalled()) return null;
    return errors.at(-1) ?? i18n.t(SILENT_CONTINUATION);
  } finally {
    subscription.unsubscribe();
  }
}
