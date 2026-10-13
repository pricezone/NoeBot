import { useQuery } from "@tanstack/react-query";
import { useComputerControl } from "@/lib/computers/use-control";
import { HelpCard, SecretCard } from "@/lib/copilot/computer-tools";
import { SignInRequestRow } from "@/lib/copilot/sign-in-tool";
import {
  FINAL_SIGN_IN,
  pendingSignInsQueryOptions,
} from "@/lib/passwords/queries";

/** What the transcript already draws, so nothing here is drawn twice. */
export type ShownCalls = {
  /** Every tool call id in the conversation as this tab has it. */
  ids: ReadonlySet<string>;
  /** Names of the tool calls that have no answer yet. */
  unanswered: ReadonlySet<string>;
};

/**
 * WHAT THE PERSON MUST DO, FROM THE SERVER, WHATEVER THIS TAB HAS LOADED.
 *
 * A Bot's sign-in, its one-value secret and its request to take over the browser are drawn by their
 * tool calls in the transcript. That only works in the tab running the turn, or in one whose history
 * loaded: on 2026-10-13 the person opened the conversation on their own device while the run was in
 * flight, the conversation service answered 404 for the thread, the history was "temporarily
 * unavailable", and the Secure Form they were waiting for never appeared. The requests themselves
 * live on the server (the sign-in requests, the computer's control state), so they are drawn from
 * there, under the conversation, for any request the transcript is not already drawing.
 */
export function PendingRequests({
  botId,
  shown,
}: {
  botId: string;
  shown: ShownCalls;
}) {
  const signIns = useQuery({
    ...pendingSignInsQueryOptions(),
    refetchInterval: 3_000,
  });
  const { control } = useComputerControl(botId);
  const open = (signIns.data ?? []).filter(
    (request) =>
      request.botId === botId &&
      !FINAL_SIGN_IN.includes(request.status) &&
      !(request.toolCallId && shown.ids.has(request.toolCallId)),
  );
  const secret =
    control?.secretWanted && !shown.unanswered.has("computer_request_secret")
      ? control.secretWanted
      : undefined;
  const help =
    control?.requested && !shown.unanswered.has("computer_request_help")
      ? (control.reason ?? "")
      : undefined;
  if (open.length === 0 && secret === undefined && help === undefined)
    return null;
  return (
    <div className="flex flex-col gap-2" data-slot="pending-requests">
      {open.map((request) => (
        <SignInRequestRow key={request.id} requestId={request.id} />
      ))}
      {secret !== undefined ? (
        <SecretCard computerId={botId} label={secret} running />
      ) : null}
      {help !== undefined ? (
        <HelpCard computerId={botId} reason={help} running />
      ) : null}
    </div>
  );
}
