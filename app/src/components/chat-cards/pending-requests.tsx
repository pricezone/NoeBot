import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { QuestionCard } from "@/components/chat-cards/question-card";
import { RecordedDecision } from "@/components/gallery/decisions";
import {
  answerQuestionsInConversation,
  approvalInboxOptions,
  type ApprovalInboxData,
  waitingDecisionsQueryOptions,
} from "@/lib/approvals";
import { useChannelStep } from "@/lib/channels/steps";
import type { LiveCalls } from "@/lib/channels/watch";
import { useComputerControl } from "@/lib/computers/use-control";
import { HelpCard, SecretCard } from "@/lib/copilot/computer-tools";
import { useConversation } from "@/lib/copilot/conversation";
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

/** How often the waiting requests are read while the conversation is open. */
const PENDING_POLL_MS = 1500;

const NOTHING_LIVE: LiveCalls = {
  ids: new Set(),
  open: new Map(),
  questions: new Set(),
};

/**
 * WHAT THE PERSON MUST DO, FROM THE SERVER, WHATEVER THIS TAB HAS LOADED.
 *
 * A Bot's sign-in, its one-value secret, its request to take over the browser, an action waiting for
 * approval, a question it put to the person and a decision card its run is waiting on are all drawn
 * by their tool calls in the transcript. That only works in the tab running the turn, or in one whose
 * history loaded: on 2026-10-13 the person opened the conversation on their own device while the run
 * was in flight, the conversation service answered 404 for the thread, the history was "temporarily
 * unavailable", and the Secure Form they were waiting for never appeared. Every one of these
 * requests also lives on the server (the sign-in requests, the computer's control state, the
 * approvals inbox and its questions, the waiting decision records), so they are drawn from there,
 * under the conversation, for any request the transcript is not already drawing.
 *
 * MATCHED BY THE REQUEST, NEVER BY THE TOOL'S NAME. A request is left to the transcript only when
 * this tab's transcript is drawing that very request live and open: the call with its id and no
 * result yet (or, for a secret, the call asking for that field). An old call left open by a turn
 * that was stopped, or one this tab merely holds, hides nothing.
 *
 * Read every second and a half, and again at once whenever the tab running the turn reports a step.
 */
export function PendingRequests({
  botId,
  channelId,
  threadId,
  shown,
  live,
}: {
  botId: string;
  /** The conversation, for its waiting decision cards and the steps its running tab reports. */
  channelId?: string;
  /** The conversation's thread, for the approvals and questions asked in it. */
  threadId?: string;
  /** What the transcript holds; `live` says which of it is still open. */
  shown: ShownCalls;
  live?: LiveCalls;
}) {
  const transcript: LiveCalls = live ?? { ...NOTHING_LIVE, ids: shown.ids };
  const signIns = useQuery({
    ...pendingSignInsQueryOptions(),
    refetchInterval: PENDING_POLL_MS,
  });
  const inbox = useQuery({
    ...approvalInboxOptions(),
    enabled: threadId !== undefined,
    refetchInterval: PENDING_POLL_MS,
  });
  const decisions = useQuery({
    ...waitingDecisionsQueryOptions(channelId ?? ""),
    enabled: channelId !== undefined,
    refetchInterval: PENDING_POLL_MS,
  });
  const { control, refresh } = useComputerControl(botId);

  // A step from the tab running the turn: something may have started waiting. Read it all again.
  const step = useChannelStep(channelId ?? "")?.step;
  const refetchSignIns = signIns.refetch;
  const refetchInbox = inbox.refetch;
  const refetchDecisions = decisions.refetch;
  useEffect(() => {
    if (step === undefined) return;
    void refetchSignIns();
    if (threadId !== undefined) void refetchInbox();
    if (channelId !== undefined) void refetchDecisions();
    void refresh?.();
  }, [
    step,
    threadId,
    channelId,
    refetchSignIns,
    refetchInbox,
    refetchDecisions,
    refresh,
  ]);

  const openCalls = [...transcript.open.entries()];
  const drawsOpen = (toolCallId: string | null | undefined) =>
    Boolean(toolCallId && transcript.open.has(toolCallId));

  const openSignIns = (signIns.data ?? []).filter(
    (request) =>
      request.botId === botId &&
      !FINAL_SIGN_IN.includes(request.status) &&
      !drawsOpen(request.toolCallId),
  );

  // The secret the computer is waiting for, unless the transcript's open call asks for that field.
  const secretDrawn = openCalls.some(
    ([, call]) =>
      call.name === "computer_request_secret" &&
      (control?.secretRef !== undefined
        ? call.args.ref === control.secretRef &&
          (control.secretSnapshotId === undefined ||
            call.args.snapshotId === control.secretSnapshotId)
        : call.args.label === control?.secretWanted),
  );
  const secret =
    control?.secretWanted && !secretDrawn ? control.secretWanted : undefined;

  // The takeover request, unless the transcript's open call is that request.
  const helpId = control?.request?.toolCallId;
  const helpDrawn = helpId
    ? drawsOpen(helpId)
    : openCalls.some(
        ([, call]) =>
          call.name === "computer_request_help" &&
          call.args.reason === control?.reason,
      );
  const help =
    control?.requested && !helpDrawn ? (control.reason ?? "") : undefined;

  // Approvals: the transcript draws one wherever its call is, for as long as it is pending.
  const approvals = (inbox.data?.requests ?? []).filter(
    (request) =>
      request.status === "pending" &&
      request.action.botId === botId &&
      request.action.threadId === threadId &&
      !(
        request.action.toolCallId &&
        transcript.ids.has(request.action.toolCallId)
      ),
  );

  const questions = (inbox.data?.questions ?? []).filter(
    (question) =>
      question.threadId === threadId &&
      !transcript.questions.has(question.question.trim()),
  );

  const waiting = (decisions.data ?? []).filter(
    (record) => !record.closed && !drawsOpen(record.toolCallId),
  );

  if (
    openSignIns.length === 0 &&
    secret === undefined &&
    help === undefined &&
    approvals.length === 0 &&
    questions.length === 0 &&
    waiting.length === 0
  )
    return null;
  return (
    <div className="flex flex-col gap-2" data-slot="pending-requests">
      {openSignIns.map((request) => (
        <SignInRequestRow key={request.id} requestId={request.id} />
      ))}
      {secret !== undefined ? (
        <SecretCard computerId={botId} label={secret} running />
      ) : null}
      {help !== undefined ? (
        <HelpCard computerId={botId} reason={help} running />
      ) : null}
      {approvals.map((request) => (
        <InlineApproval
          fallback={null}
          key={request.id}
          requestId={request.id}
          {...(request.action.toolCallId
            ? { toolCallId: request.action.toolCallId }
            : {})}
        />
      ))}
      {questions.map((question) => (
        <PendingQuestion key={question.id} question={question} />
      ))}
      {waiting.map((record) => (
        <RecordedDecision key={record.toolCallId} record={record} />
      ))}
    </div>
  );
}

/**
 * A question a Bot put to the person (`ask_person`), drawn from the inbox for a tab whose transcript
 * does not hold it. The Bot's turn ended when it asked, so the answer is the person's next message,
 * sent here; the question is then closed with that answer, as answering in the conversation does.
 */
function PendingQuestion({
  question,
}: {
  question: ApprovalInboxData["questions"][number];
}) {
  const conversation = useConversation();
  const cache = useQueryClient();
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (text: string) => {
    if (!conversation || sending) return;
    setSending(text);
    setError(null);
    try {
      if ((await conversation.ask(text)) === false)
        throw new Error("Your answer could not be sent. Try again.");
      await answerQuestionsInConversation({
        threadId: question.threadId,
        questions: [question.question],
        response: text,
      }).catch(() => undefined);
      void cache.invalidateQueries({
        queryKey: approvalInboxOptions().queryKey,
      });
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message
          ? failure.message
          : "Your answer could not be sent. Try again.",
      );
    } finally {
      setSending(null);
    }
  };
  return (
    <QuestionCard
      footer={
        error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null
      }
      onOwnAnswer={conversation ? (text) => void answer(text) : undefined}
      sending={sending === null ? undefined : { text: sending }}
      subtitle={question.why}
      title={question.question}
    />
  );
}
