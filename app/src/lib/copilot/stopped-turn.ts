import { useAgent } from "@copilotkit/react-core/v2";
import { useEffect, useState } from "react";

/**
 * Why the last turn ended without an answer, for a surface that has to say so itself.
 *
 * A run can end three ways. It finishes, which needs no explanation. It fails in the browser, which
 * arrives as an error. Or the Bot's own stream stops producing anything and this deployment ends the
 * turn for it, which arrives as a RUN_ERROR carrying the sentence the server wrote (see
 * server/src/channels/stall-guard.ts). The last two both leave the same hole on screen: the composer
 * unlocks, the spinner disappears, and nothing says what happened.
 *
 * The reason is kept as a sentence rather than a flag because the reasons are not interchangeable. A
 * Bot that refused, a Bot whose endpoint is down and a Bot that simply stopped talking are three
 * different things to be told, and only the thing that ended the turn knows which one it was.
 */

/**
 * The sentence to show, in the words of whatever ended the turn.
 *
 * Falls back only when there is genuinely nothing to pass on. Saying "the Bot stopped without saying
 * why" is honest about that; inventing a cause would not be, and this is the one moment a person has
 * no other way to find out what went wrong.
 */
export function stoppedReason(reported: unknown): string {
  const said =
    reported instanceof Error
      ? reported.message
      : typeof reported === "string"
        ? reported
        : "";
  return plainSentence(said.trim()) || "The Bot stopped without saying why.";
}

/**
 * What the runtime answers when a turn cannot start, as the person should read it.
 *
 * The SDK reports a run request the server refused as `REST run request failed: <body>`, and the
 * body is the runtime's own JSON: `{"error":"Failed to resolve Learning Container"}` on a wobble of
 * the conversation service, `Failed to initialize thread` when the service is down, `Thread lock
 * denied` while another run holds the conversation. Each is a thing the person can act on, and none
 * of them reads as one in the raw. Anything without that prefix is somebody's own sentence already
 * (the stall watchdog's, a refusal's) and goes through untouched.
 */
const RUN_REQUEST_FAILED = /^REST (?:run|connect) request failed: ([\s\S]*)$/;
const SERVICE_SENTENCES: readonly [RegExp, string][] = [
  [
    /Failed to resolve Learning Container|Failed to initialize thread/,
    "The conversation service did not answer, so this turn could not start. Try again in a moment.",
  ],
  [
    /Thread lock denied/,
    "Another run is still in progress on this conversation. Wait for it to finish, then try again.",
  ],
];

export function plainSentence(said: string): string {
  const match = RUN_REQUEST_FAILED.exec(said);
  if (!match) return said;
  const body = match[1] ?? "";
  let error = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof parsed.error === "string"
    )
      error = parsed.error;
  } catch {
    // Not JSON: a proxy's HTML page, or an empty answer. The generic sentence below covers it.
  }
  for (const [pattern, sentence] of SERVICE_SENTENCES)
    if (pattern.test(error)) return sentence;
  return "The Bot could not start this turn. Try again in a moment.";
}

/**
 * Watch one Bot's runs and hold on to the reason the last one ended, if it ended badly.
 *
 * Bound by agent id rather than handed an agent, so a caller that only renders the packaged chat
 * does not have to reach for one: `useAgent` returns the same shared instance the chat itself binds
 * to, so this watches exactly the runs that chat starts.
 *
 * Cleared when the next run begins rather than on a timer. A sentence about a turn that is over
 * should stay until there is something newer to look at, and the person deciding when that is is the
 * one who sends the next message.
 */
export function useStoppedTurn(agentId: string): string | null {
  const { agent } = useAgent({ agentId });
  const [stopped, setStopped] = useState<string | null>(null);

  useEffect(() => {
    const subscription = agent.subscribe?.({
      onRunInitialized: () => setStopped(null),
      onRunErrorEvent: ({ event }) => setStopped(stoppedReason(event?.message)),
      onRunFailed: ({ error }) => setStopped(stoppedReason(error)),
    });
    return () => subscription?.unsubscribe();
  }, [agent]);

  return stopped;
}
