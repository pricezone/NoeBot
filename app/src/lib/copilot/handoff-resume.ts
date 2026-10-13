import type { Message, ToolCall } from "@ag-ui/core";
import {
  awaitHandoff,
  awaitServerWait,
  claimServerWait,
  forgetHandoff,
  hasActiveHandoff,
  type PendingHandoff,
  readServerWait,
} from "@/lib/computers/handoff";
import { newId } from "@/lib/new-id";
import { repairUnansweredToolCalls } from "./repair-history";

export type HandoffAgent = {
  messages: Message[];
  isRunning: boolean;
  setMessages: (messages: Message[]) => void;
  /** The conversation, to find a wait the server recorded for an in-run call. */
  threadId?: string;
};

/** Calls a run can stop on to wait for the person, in the browser or (in-run) on the server. */
const RESUMABLE_TOOLS = [
  "computer_request_help",
  "computer_navigate",
  "computer_read",
  "computer_snapshot",
  "computer_request_sign_in",
  "computer_request_secret",
];

/** These are transport placeholders / retryable transport failures, never accepted results. */
function needsAnswer(message: Message): boolean {
  if (message.role !== "tool") return false;
  if (message.content.trim() === "Forwarded to client") return true;
  try {
    const result: unknown = JSON.parse(message.content);
    if (result === "Forwarded to client") return true;
    return Boolean(
      result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false &&
        (("reconnecting" in result && result.reconnecting === true) ||
          ("snapshotRequired" in result && result.snapshotRequired === true)),
    );
  } catch {
    return false;
  }
}

export function findPendingTool(
  messages: Message[],
  pending: PendingHandoff,
): ToolCall | null {
  const call = messages
    .flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls ?? []) : [],
    )
    .find(
      (tool) =>
        tool.id === pending.toolCallId &&
        RESUMABLE_TOOLS.includes(tool.function.name),
    );
  if (!call) return null;
  const accepted = messages.some(
    (message) =>
      message.role === "tool" &&
      message.toolCallId === call.id &&
      !needsAnswer(message),
  );
  return accepted ? null : call;
}

/** Resume the restored call on its original channel agent; never add a new user task. */
export async function resumeHandoffTask(
  botId: string,
  pending: PendingHandoff,
  agent: HandoffAgent,
  run: () => Promise<unknown>,
  signal?: AbortSignal,
) {
  const hasCall = agent.messages.some(
    (m) =>
      m.role === "assistant" &&
      m.toolCalls?.some((c) => c.id === pending.toolCallId),
  );
  if (!hasCall)
    throw new Error("The handoff's tool call is not in this conversation.");
  if (!findPendingTool(agent.messages, pending))
    throw new Error("This tool call is already answered.");
  if (agent.isRunning || hasActiveHandoff(botId, pending.requestId))
    throw new Error("This task is already running.");
  const content = await resultFor(botId, pending, agent, signal);
  if (content === undefined) return;
  // Another handler/tab may have supplied the result while we waited. Keep accepted work accepted.
  if (!findPendingTool(agent.messages, pending)) return;
  const messages = agent.messages.filter(
    (m) =>
      !(
        m.role === "tool" &&
        m.toolCallId === pending.toolCallId &&
        needsAnswer(m)
      ),
  );
  const caller = messages.findIndex(
    (m) =>
      m.role === "assistant" &&
      m.toolCalls?.some((c) => c.id === pending.toolCallId),
  );
  messages.splice(caller + 1, 0, {
    id: newId(),
    role: "tool",
    toolCallId: pending.toolCallId,
    content,
  });
  agent.setMessages([...repairUnansweredToolCalls(messages)]);
  forgetHandoff(botId, pending.requestId);
  await run();
}

/**
 * The tool result the paused call resumes with, or undefined when the wait was abandoned.
 *
 * A call the server carried out inside the run (COMPUTER_TOOLS_IN_RUN) has a wait the server
 * recorded: it is claimed, so exactly one of this tab and the server continues the run, and resumes
 * with the result the server built. Otherwise the browser watches the handoff itself, as before.
 */
async function resultFor(
  botId: string,
  pending: PendingHandoff,
  agent: HandoffAgent,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const threadId = agent.threadId;
  const wait = threadId
    ? await readServerWait(threadId, pending.toolCallId, signal).catch(
        () => null,
      )
    : null;
  if (wait && threadId) {
    const answered =
      wait.status === "waiting"
        ? await awaitServerWait(threadId, pending.toolCallId, signal)
        : wait.status;
    if (signal?.aborted || answered === "stopped") return undefined;
    const content =
      answered === "ready"
        ? await claimServerWait(threadId, pending.toolCallId, signal)
        : null;
    if (content === null)
      throw new Error(
        "This task was already continued. Its answer appears in the conversation.",
      );
    return content;
  }
  const result = await awaitHandoff(botId, pending.requestId, signal);
  if (signal?.aborted) return undefined;
  if (result.reconnecting || result.snapshotRequired)
    throw new Error(
      String(
        result.reason ?? "The computer could not be reached. Retry to resume.",
      ),
    );
  return JSON.stringify(result);
}
