import { isDeepStrictEqual } from "node:util";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { LedgerVerdict } from "../runs/ledger";
import { ApprovalRefusedError, ApprovalUnavailableError } from "./types";

type SavedHistory = Awaited<
  ReturnType<CopilotKitIntelligence["getThreadMessages"]>
>;

/**
 * Whether a failed read of the saved conversation is the service's fault rather than the request's.
 *
 * The conversation service answers a 5xx, or marks an error retryable, when it is the one in
 * trouble; its client throws a bare `SyntaxError` when a 200 arrives with a body that is not JSON,
 * which is what a proxy in front of a struggling backend produces; and `fetch` throws a `TypeError`
 * (or an abort) when the network itself fails. None of those says anything about the action being
 * checked, so none of them may refuse it.
 */
export function isTransientHistoryFailure(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (error instanceof Error && error.name === "PlatformRequestError") {
    const status = (error as { status?: unknown }).status;
    const retryable = (error as { retryable?: unknown }).retryable;
    return retryable === true || (typeof status === "number" && status >= 500);
  }
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export type SavedToolCallCheck = {
  toolCallId: string;
  toolName: string;
  /** The arguments the browser says the call carries; must equal the saved ones. */
  args: unknown;
  /** One read of the saved conversation. */
  read: () => Promise<SavedHistory>;
  /**
   * The server's own record of this call (runs/ledger.ts), bound to it, asked before the
   * conversation and again on every round. `consume` marks a matching call used; `settle` marks a
   * call the conversation vouched for, so the ledger cannot pass it a second time.
   */
  ledger?: {
    consume: () => Promise<LedgerVerdict>;
    settle?: () => Promise<void>;
  };
  /** Rounds before giving up on a call that never appears: 48 rounds 250 ms apart is twelve seconds. */
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Told about every read the service failed, with what it said and nothing else. */
  warn?: (detail: { attempt: number; failure: string }) => void;
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a failure looks like in a log line: its status or its name, never a body. */
function describeFailure(error: unknown): string {
  if (error instanceof Error && error.name === "PlatformRequestError") {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number"
      ? `PlatformRequestError ${status}`
      : "PlatformRequestError";
  }
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Require that the tool call a browser is about to act on is the one saved in the conversation.
 *
 * The browser runs a tool the moment the call streams to it, and the conversation service saves
 * the run's messages a moment behind the stream, so the first read may not have the call yet and a
 * few more are made. Three outcomes are told apart on purpose:
 *
 * - FOUND, with the same name and arguments and no answer yet: the check passes.
 * - NOT FOUND after every read, or found but different, or already answered: refused. That is the
 *   anti-forgery property this check exists for, and it must stay a refusal.
 * - NEVER READ, because the service failed every single time: unavailable, not refused. Until this
 *   distinction existed a service hiccup refused the action as "Supply a valid request.", the person
 *   saw a click that was never completed, and nothing anywhere said the service had been the cause.
 *
 * A read that fails after one that succeeded does not make the call unavailable: the conversation
 * was readable, the call was simply not in it, and a refusal is the honest answer.
 */
export async function requireSavedToolCall(
  input: SavedToolCallCheck,
): Promise<void> {
  /*
   * THE LEDGER FIRST. The server recorded every call its model streamed (runs/ledger.ts), so a call
   * that is there passes in one read, instantly, and is marked used so it cannot pass again. A call
   * recorded differently, or already used, is refused outright: that is the anti-forgery and
   * anti-replay property, and the conversation service is not asked to overrule it.
   *
   * Only a call the ledger does not hold falls back to the conversation service, which saves a run's
   * messages a moment behind the stream: on 2026-10-13 a gov.gr run had a click refused twice while
   * the service was answering 404 and 502. Asked every 250 ms for about twelve seconds, with the
   * ledger asked again each round, since its write may land while this waits.
   */
  const askLedger = async (): Promise<LedgerVerdict> => {
    if (!input.ledger) return "missing";
    try {
      return await input.ledger.consume();
    } catch (error) {
      input.warn?.({ attempt: -1, failure: describeFailure(error) });
      return "missing";
    }
  };
  const verdict = await askLedger();
  if (verdict === "ok") return;
  if (verdict !== "missing")
    throw new ApprovalRefusedError(
      verdict === "replayed"
        ? "That tool call was already carried out once. It was not repeated."
        : "That unanswered tool call is not saved in this conversation.",
    );
  const attempts = input.attempts ?? 48;
  const delayMs = input.delayMs ?? 250;
  const sleep = input.sleep ?? pause;
  let reads = 0;
  let failures = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await sleep(delayMs);
      const late = await askLedger();
      if (late === "ok") return;
      if (late !== "missing")
        throw new ApprovalRefusedError(
          "That unanswered tool call is not saved in this conversation.",
        );
    }
    let history: SavedHistory;
    try {
      history = await input.read();
    } catch (error) {
      if (!isTransientHistoryFailure(error)) throw error;
      failures++;
      input.warn?.({ attempt, failure: describeFailure(error) });
      continue;
    }
    reads++;
    const call = history.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.id === input.toolCallId);
    if (!call) continue;
    const savedArgs = parseSavedArgs(call.args);
    const answered = history.messages.some(
      (message) =>
        message.role === "tool" && message.toolCallId === input.toolCallId,
    );
    if (
      call.name !== input.toolName ||
      savedArgs === INVALID ||
      !isDeepStrictEqual(savedArgs, input.args) ||
      answered
    )
      throw new ApprovalRefusedError(
        "That unanswered tool call is not saved in this conversation.",
      );
    // Vouched for by the conversation: the ledger must not let the same call through again.
    await input.ledger?.settle?.().catch((error: unknown) => {
      input.warn?.({ attempt, failure: describeFailure(error) });
    });
    return;
  }
  if (reads === 0 && failures > 0)
    throw new ApprovalUnavailableError(
      "The conversation service did not answer, so this action could not be checked. Try it again.",
    );
  throw new ApprovalRefusedError(
    "That unanswered tool call is not saved in this conversation.",
  );
}

const INVALID = Symbol("invalid saved arguments");

/** The saved call's arguments as a value; a string the service could not have saved is a mismatch. */
function parseSavedArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return INVALID;
  }
}
