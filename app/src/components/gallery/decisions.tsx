import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  type QuestionAnswer,
  QuestionCard,
  QuestionScreen,
} from "@/components/chat-cards/question-card";
import {
  answerWaitingDecision,
  closeWaitingDecision,
  heartbeatWaitingDecision,
  openWaitingDecision,
  readWaitingDecision,
  type WaitingDecision,
  type WaitingDecisionArgs,
  type WaitingDecisionKind,
} from "@/lib/approvals";
import { useChannelStep } from "@/lib/channels/steps";
import { isForwardedPlaceholder } from "@/lib/channels/watch";
import { useConversation } from "@/lib/copilot/conversation";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { i18n } from "@/lib/i18n";
import { useUiStrings } from "@/lib/i18n/strings";

/**
 * Human-in-the-loop gallery components. `respond` resolves the suspended Bot run, and completed
 * cards render the recorded answer rather than active controls.
 */

/** What the render props carry. Narrowed here so each component reads as its own small contract. */
type Waiting<T> =
  | {
      status: "inProgress";
      args: Partial<T>;
      respond: undefined;
      result: undefined;
    }
  | {
      status: "executing";
      args: T;
      respond: (result: unknown) => Promise<void>;
      result: undefined;
    }
  | { status: "complete"; args: T; respond: undefined; result: string };

/**
 * A card whose only result is the runtime's "forwarded to client" placeholder, read back by another
 * tab while the tab running the turn still waits on it, is still waiting: drawn as in progress, so it
 * can be answered from here (`useChatAnswer`), never as answered with nothing.
 */
function stillWaiting<P extends { status: string; result?: unknown }>(
  props: P,
): P {
  return props.status === "complete" && isForwardedPlaceholder(props.result)
    ? { ...props, status: "inProgress", result: undefined, respond: undefined }
    : props;
}

/** What a card says under its rows when an answer did not leave, so it can be given again. */
const NOT_SENT = "Your answer could not be sent. Try again.";

/**
 * The sentence for a failed answer: the server's or the card's own, never nothing. Kept in English
 * and drawn through `ui.reason`, which says the sentences it knows in the conversation's language.
 */
function sendError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : NOT_SENT;
}

/** How often the tab holding the run says so, and how often it looks for an answer given elsewhere. */
const HEARTBEAT_MS = 5000;
const ANSWER_POLL_MS = 1000;
/** How often a card this tab cannot answer through the run looks for an answer given elsewhere. */
const STORED_ANSWER_POLL_MS = 3000;

/**
 * Answer a decision whose run this tab does not hold.
 *
 * Through its record first: while the tab holding the run is still there, the answer is written to
 * the record and that tab hands it to the waiting run, which carries on exactly where it stopped.
 * When no tab holds the run — the record is stale or was never written — the answer goes as the
 * person's next message instead (`text`), and the record is closed with it so no tab offers the
 * card again. Throws when neither could be done, so the card can say so and take the answer again.
 */
export async function answerElsewhere(
  conversation: ReturnType<typeof useConversation>,
  toolCallId: string | undefined,
  value: unknown,
  text: string,
): Promise<void> {
  if (toolCallId && conversation?.channelId) {
    const outcome = await answerWaitingDecision(toolCallId, value);
    if (outcome === "delivered") return;
    if (outcome === "answered")
      throw new Error(i18n.t("This question was already answered."));
  }
  // Not sent at all: the card takes an answer again.
  if ((await conversation?.ask(text)) === false)
    throw new Error(i18n.t("The answer was not sent."));
  if (toolCallId && conversation?.channelId)
    void closeWaitingDecision(toolCallId, value);
}

/** A question with a title: enough for an approval, whose rows are its own. */
function titled(args: { title?: unknown }): boolean {
  return typeof args.title === "string" && args.title !== "";
}

/**
 * A choice whose title and options are all written. A card read back while the Bot was still writing
 * it has its title and no options yet, and offered then it was a question with nothing to pick but
 * "Type your own answer".
 */
function choiceWritten(args: { title?: unknown; options?: unknown }): boolean {
  const { options } = args;
  return (
    titled(args) &&
    Array.isArray(options) &&
    options.length > 0 &&
    options.every(
      (option: unknown) =>
        typeof option === "object" &&
        option !== null &&
        "id" in option &&
        typeof option.id === "string" &&
        option.id !== "" &&
        "label" in option &&
        typeof option.label === "string" &&
        option.label !== "",
    )
  );
}

/**
 * A decision card this tab cannot answer through the run, answered from here anyway.
 *
 * A decision suspends the run in the tab that started it, and only that tab holds what resumes it.
 * Drawn anywhere else — the person's own tab while the Bot was driven from another, or the same tab
 * after a reload — the card arrives with no result and nothing executing it, which the runtime calls
 * "in progress" for good: the options were hidden as if still being written, and the question could
 * not be answered at all. So when this tab has no turn going and the question is written, the card
 * takes an answer: handed to the tab holding the run when there is one, and otherwise sent as the
 * person's next message, the way a Bot's `ask_person` question is answered; the history repair then
 * tells the Bot that message is the answer. See `answerElsewhere`.
 *
 * `answer` is what the person said after the question, read off the transcript (see
 * `question-answers.ts`), for a card whose own result does not hold one. `stored` is the answer the
 * server's record of the card holds, given in another tab, so the card is drawn answered there too
 * — and after a reload — before the run's own result has reached this tab's history.
 *
 * ONLY ONCE THE QUESTION IS WRITTEN (`written`). A card read back mid-stream has its title and not yet
 * its options; answerable then, it took only words. So the server's record of the card is read while
 * it waits, and its arguments (written by the tab holding the run, from the finished call) are
 * `recordArgs`, which the card draws in place of its own; with neither written, the card says it is
 * preparing the question until its arguments arrive.
 */
function useChatAnswer(
  props: {
    status: "inProgress" | "executing" | "complete";
    args: { title?: unknown; options?: unknown };
    toolCallId?: string;
  },
  written: (args: { title?: unknown; options?: unknown }) => boolean,
) {
  const conversation = useConversation();
  const id = props.toolCallId;
  const answer =
    id && props.status !== "executing"
      ? conversation?.answers?.get(id)
      : undefined;
  /** Waiting with nothing here running it: another tab started it, or this one was reloaded. */
  const orphaned =
    props.status === "inProgress" &&
    answer === undefined &&
    conversation?.turnActive === false &&
    Boolean(id);
  const channelId = conversation?.channelId;
  const [record, setRecord] = useState<WaitingDecision | null>(null);
  useEffect(() => {
    if (!orphaned || !id || !channelId) return;
    let current = true;
    const read = () =>
      void readWaitingDecision(id).then((found) => {
        if (current) setRecord(found);
      });
    read();
    const timer = setInterval(read, STORED_ANSWER_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [orphaned, id, channelId]);
  const recordArgs =
    orphaned && record && written(record.args) ? record.args : undefined;
  const answerable =
    orphaned && (recordArgs !== undefined || written(props.args));
  const send = (value: unknown, text: string) =>
    answerElsewhere(conversation, id, value, text);
  return {
    answer,
    answerable,
    recordArgs,
    send,
    stored: answerable ? (record?.answer ?? null) : null,
  };
}

/**
 * The record of a decision this tab's run is waiting on, kept while it waits.
 *
 * Opened when the card starts waiting, heartbeated every five seconds, and read every second (and on
 * every step another tab reports) for an answer given in another tab, which is then handed to the
 * waiting run through `respond` — the same call an answer picked on this card makes. Gone with the
 * card: a tab that closes stops heartbeating, the record goes stale, and an answer given elsewhere
 * then travels as a message instead.
 *
 * `answered` tells the hook this card already has its answer on the way, so a late one from another
 * tab is not handed over as well.
 */
function useHeldDecision({
  kind,
  toolCallId,
  args,
  respond,
  answered,
  onAnswered,
}: {
  kind: WaitingDecisionKind;
  toolCallId?: string;
  args: WaitingDecisionArgs | undefined;
  respond: ((result: unknown) => Promise<void>) | undefined;
  answered: () => boolean;
  /** An answer from another tab reached the run. */
  onAnswered: (answer: unknown) => void;
}) {
  const conversation = useConversation();
  const botId = conversation?.botId;
  const channelId = conversation?.channelId;
  const step = useChannelStep(channelId ?? "")?.step;
  const holding = Boolean(
    respond && toolCallId && botId && channelId && args?.title,
  );
  const latest = useRef({ args, respond, answered, onAnswered });
  latest.current = { args, respond, answered, onAnswered };
  const check = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!holding || !toolCallId || !botId || !channelId) return;
    let current = true;
    let handing = false;
    const open = () => {
      const recordArgs = latest.current.args;
      if (!recordArgs) return Promise.resolve(null);
      return openWaitingDecision({
        botId,
        channelId,
        toolCallId,
        kind,
        args: recordArgs,
      });
    };
    check.current = async () => {
      if (!current || handing || latest.current.answered()) return;
      const record = await readWaitingDecision(toolCallId);
      if (!current || !record || record.closed || record.answer === null)
        return;
      const answer =
        kind === "approval"
          ? readApproval(JSON.stringify(record.answer))
          : readChoiceAnswer(JSON.stringify(record.answer));
      const run = latest.current.respond;
      if (!answer || !run || latest.current.answered()) return;
      handing = true;
      try {
        await run(answer);
        latest.current.onAnswered(answer);
        void closeWaitingDecision(toolCallId);
      } catch {
        // The run is gone; the record stays answered for whoever reads it next.
      } finally {
        handing = false;
      }
    };
    void open();
    const beat = setInterval(() => {
      void heartbeatWaitingDecision(toolCallId).then((record) => {
        // Never written (or lost): written again, so the other tabs can still see the card.
        if (current && record === null) void open();
      });
    }, HEARTBEAT_MS);
    const poll = setInterval(() => void check.current(), ANSWER_POLL_MS);
    return () => {
      current = false;
      clearInterval(beat);
      clearInterval(poll);
    };
  }, [holding, toolCallId, botId, channelId, kind]);

  // Another tab moved: look for its answer now rather than at the next poll.
  useEffect(() => {
    if (step !== undefined) void check.current();
  }, [step]);
}

export const ApprovalCardProps = z.object({
  title: z.string().describe("What is being approved, in a few words"),
  summary: z
    .string()
    .describe("What the person is agreeing to, in one or two sentences"),
  details: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe(
      "The facts they need in order to decide, e.g. amount, vendor, date",
    ),
  approveLabel: z.string().optional().describe("Defaults to Approve"),
  rejectLabel: z.string().optional().describe("Defaults to Decline"),
});

type ApprovalArgs = z.infer<typeof ApprovalCardProps>;

/** The decision an approval records, with the reason typed beside it, when there was one. */
type ApprovalAnswer = { decision: "approved" | "declined"; note?: string };

/** What a record keeps of an approval card, so another tab can draw the same one. */
function approvalRecordArgs(
  args: Partial<ApprovalArgs>,
): WaitingDecisionArgs | undefined {
  if (!args.title) return undefined;
  return {
    title: args.title,
    ...(args.summary ? { summary: args.summary } : {}),
    ...(args.details?.length ? { details: args.details } : {}),
    ...(args.approveLabel ? { approveLabel: args.approveLabel } : {}),
    ...(args.rejectLabel ? { rejectLabel: args.rejectLabel } : {}),
  };
}

/** An approval card's arguments, read back from its record. */
function approvalArgsOf(args: WaitingDecisionArgs): ApprovalArgs {
  return {
    title: args.title,
    summary: args.summary ?? "",
    ...(args.details ? { details: args.details } : {}),
    ...(args.approveLabel ? { approveLabel: args.approveLabel } : {}),
    ...(args.rejectLabel ? { rejectLabel: args.rejectLabel } : {}),
  };
}

/**
 * Approve or decline, drawn as the question card: the request as its question, the summary and the
 * facts under it, Approve and Decline as rows A and B.
 *
 * The field under the rows is the reason. Typed and then a row picked, it travels with that
 * decision, as the reason box always did. Typed and sent on its own it is an answer that is not
 * "approve", so it goes out as a decline carrying the person's words: the Bot learns what they want
 * instead, and nothing irreversible happens on an answer that never said yes.
 *
 * `record` draws the card from the server's record of it (`PendingRequests`), for a tab whose
 * transcript does not hold the question: answered there, it goes to the tab holding the run.
 */
export function ApprovalCard(
  drawn: Waiting<ApprovalArgs> & {
    name?: string;
    toolCallId?: string;
    record?: WaitingDecision;
  },
) {
  const props = stillWaiting(drawn);
  const { record } = props;
  const ui = useUiStrings();
  const conversation = useConversation();
  const [sending, setSending] = useState<ApprovalAnswer | null>(null);
  const [sent, setSent] = useState<ApprovalAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chat = useChatAnswer(props, titled);
  // Read back half written, the card draws its record's arguments: the finished call's.
  const args: Partial<ApprovalArgs> = chat.recordArgs
    ? approvalArgsOf(chat.recordArgs)
    : props.args;
  const approveLabel = args.approveLabel ?? "Approve";
  const rejectLabel = args.rejectLabel ?? "Decline";

  const recorded =
    props.status === "complete" ? readApproval(props.result) : undefined;
  /** Said in the chat instead: a row's label (and a reason after it), or words of their own. */
  const inChat =
    recorded || chat.answer === undefined
      ? undefined
      : approvalFromText(chat.answer, approveLabel, rejectLabel);
  /** Answered in another tab and not yet handed to the run: drawn as answered all the same. */
  const recordAnswer = record?.answer ?? chat.stored;
  const fromRecord = recordAnswer
    ? readApproval(JSON.stringify(recordAnswer))
    : undefined;
  const decided =
    recorded ??
    (inChat && "decision" in inChat ? inChat : (sent ?? fromRecord ?? null));

  // The run waits in this tab: keep its record, and take an answer given in another tab.
  const holdsRun = props.status === "executing" && !record;
  const sendingRef = useRef(false);
  sendingRef.current = sending !== null || decided !== null;
  useHeldDecision({
    kind: "approval",
    toolCallId: props.toolCallId,
    args: holdsRun ? approvalRecordArgs(args) : undefined,
    respond: holdsRun ? props.respond : undefined,
    answered: () => sendingRef.current,
    onAnswered: (answer) => setSent(answer as ApprovalAnswer),
  });

  if (props.status === "inProgress" && !chat.answerable && !inChat) {
    return (
      <QuestionCard
        subtitle={ui.preparingRequest}
        title={args.title || ui.waitingForBot}
      />
    );
  }

  const asText = (value: ApprovalAnswer) =>
    `${value.decision === "approved" ? approveLabel : rejectLabel}${value.note ? `: ${value.note}` : ""}`;
  const respond =
    chat.answerable || record
      ? (value: ApprovalAnswer) =>
          record
            ? answerElsewhere(
                conversation,
                record.toolCallId,
                value,
                asText(value),
              )
            : chat.send(value, asText(value))
      : props.respond;

  const answer = async (decision: ApprovalAnswer["decision"], note: string) => {
    if (!respond || sending || decided) return;
    // Include the note in the same tool result that resumes the Bot.
    const value = { decision, note: note.trim() || undefined };
    setSending(value);
    setError(null);
    try {
      await respond(value);
      setSent(value);
      // Answered here: the record, if this tab keeps one, is done with.
      if (holdsRun && props.toolCallId)
        void closeWaitingDecision(props.toolCallId, value);
    } catch (failure) {
      // Not sent, so not decided: the card takes an answer again, and says why.
      setError(sendError(failure));
    } finally {
      setSending(null);
    }
  };

  const options = [
    { id: "approved", label: approveLabel },
    { id: "declined", label: rejectLabel },
  ];
  const asAnswer = (value: ApprovalAnswer): QuestionAnswer => ({
    optionId: value.decision,
    note: value.note,
  });

  return (
    <QuestionCard
      answered={
        decided
          ? asAnswer(decided)
          : inChat && "text" in inChat
            ? inChat
            : undefined
      }
      footer={
        error ? (
          <p className="text-destructive text-sm" role="alert">
            {ui.reason(error)}
          </p>
        ) : null
      }
      onOwnAnswer={
        respond ? (text) => void answer("declined", text) : undefined
      }
      onPick={
        respond
          ? (option, typed) =>
              void answer(
                option.id === "approved" ? "approved" : "declined",
                typed,
              )
          : undefined
      }
      options={options}
      screen={
        <QuestionScreen
          computerId={conversation?.botId}
          toolCallId={props.toolCallId}
          waiting={!decided}
        />
      }
      sending={sending ? asAnswer(sending) : undefined}
      subtitle={args.summary}
      title={args.title ?? ""}
    >
      {args.details?.length ? (
        <dl className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-1 text-sm">
          {args.details.map((detail) => (
            <div className="contents" key={detail.label}>
              <dt className="truncate text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </QuestionCard>
  );
}

export const ChoiceCardProps = z.object({
  title: z.string().describe("The question being asked"),
  summary: z
    .string()
    .optional()
    .describe("Any context the person needs to choose"),
  options: z
    .array(
      z.object({
        id: z
          .string()
          .describe("What comes back to you when this one is picked"),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .describe("The options, in the order they should be offered"),
});

type ChoiceArgs = z.infer<typeof ChoiceCardProps>;

/**
 * The answer a person gave, in the shape it is recorded: the option's id, or — for an answer they
 * typed themselves — their words, marked as typed. One shape for both, so a reader of the result
 * never has to learn a second one.
 */
export type ChoiceAnswer = { choice: string; label: string; typed?: true };

/** What a record keeps of a choice card, so another tab can draw the same one. */
function choiceRecordArgs(
  args: Partial<ChoiceArgs>,
): WaitingDecisionArgs | undefined {
  if (!args.title) return undefined;
  return {
    title: args.title,
    ...(args.summary ? { summary: args.summary } : {}),
    options: (args.options ?? []).filter(
      (option): option is ChoiceArgs["options"][number] =>
        Boolean(option?.id && option.label),
    ),
  };
}

/** A choice card's arguments, read back from its record. */
function choiceArgsOf(args: WaitingDecisionArgs): ChoiceArgs {
  return {
    title: args.title,
    ...(args.summary ? { summary: args.summary } : {}),
    options: args.options ?? [],
  };
}

/**
 * A question with lettered options and a field for an answer of the person's own.
 *
 * Drawn the same for the two things that ask one. `askChoice` suspends the run and its answer is
 * the tool result (`respond`); a Bot's `ask_person` question with options has already ended its turn,
 * and the answer is the person's next message — see `lib/copilot/escalation-tool.tsx`, which hands
 * this a `respond` that sends one. Either way an option and a typed answer go out through the same
 * `respond`, so typing is never a second-class way to answer.
 *
 * `onDismiss` puts an X beside the question for a caller that can do without the card: the person
 * then answers in the composer like any other message. `record` draws it from the server's record,
 * as for an approval; `held: false` is for a caller whose `respond` is not a run waiting in this tab
 * (an `ask_person` question), so no record is kept for it.
 */
export function ChoiceCard(
  drawn: Waiting<ChoiceArgs> & {
    onDismiss?: () => void;
    toolCallId?: string;
    record?: WaitingDecision;
    held?: false;
  },
) {
  const props = stillWaiting(drawn);
  const { onDismiss, record } = props;
  const ui = useUiStrings();
  const conversation = useConversation();
  /** The answer on its way out, so the card stops taking answers at once. */
  const [sending, setSending] = useState<ChoiceAnswer | null>(null);
  /** Sent, before the transcript has caught up with it. */
  const [sent, setSent] = useState<ChoiceAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chat = useChatAnswer(props, choiceWritten);
  // Read back with its options still unwritten, the card draws its record's: the finished call's.
  const args: Partial<ChoiceArgs> = chat.recordArgs
    ? choiceArgsOf(chat.recordArgs)
    : props.args;
  // Answerable here without the run: drawn as waiting on an answer, and an answer goes out from here.
  const status = chat.answerable || record ? "executing" : props.status;
  const respond =
    chat.answerable || record
      ? (value: unknown) => {
          const text =
            value && typeof value === "object" && "label" in value
              ? String(value.label)
              : "";
          return record
            ? answerElsewhere(conversation, record.toolCallId, value, text)
            : chat.send(value, text);
        }
      : props.respond;

  const recorded =
    props.status === "complete" ? readChoiceAnswer(props.result) : undefined;
  const inChat =
    recorded || chat.answer === undefined
      ? undefined
      : choiceFromText(chat.answer, args.options ?? []);
  const recordAnswer = record?.answer ?? chat.stored;
  const fromRecord = recordAnswer
    ? readChoiceAnswer(JSON.stringify(recordAnswer))
    : undefined;
  const given = recorded ?? inChat ?? sent ?? fromRecord ?? undefined;
  const options = status === "inProgress" && !given ? [] : (args.options ?? []);
  const open = status === "executing" && Boolean(respond) && !given;

  // The run waits in this tab: keep its record, and take an answer given in another tab.
  const holdsRun =
    props.status === "executing" && !record && props.held !== false;
  const answeredRef = useRef(false);
  answeredRef.current = sending !== null || given !== undefined;
  useHeldDecision({
    kind: "choice",
    toolCallId: props.toolCallId,
    args: holdsRun ? choiceRecordArgs(args) : undefined,
    respond: holdsRun ? props.respond : undefined,
    answered: () => answeredRef.current,
    onAnswered: (answer) => setSent(answer as ChoiceAnswer),
  });

  const answer = async (value: ChoiceAnswer) => {
    if (!respond || !open || sending) return;
    setSending(value);
    setError(null);
    try {
      await respond(value);
      setSent(value);
      // Answered here: the record, if this tab keeps one, is done with.
      if (holdsRun && props.toolCallId)
        void closeWaitingDecision(props.toolCallId, value);
    } catch (failure) {
      // Not sent, so not answered: the card takes an answer again, and says why.
      setError(sendError(failure));
    } finally {
      setSending(null);
    }
  };

  /** A picked option is drawn as its row; anything else is what the person typed. */
  const asAnswer = (value: ChoiceAnswer): QuestionAnswer =>
    options.some((option) => option.id === value.choice)
      ? { optionId: value.choice }
      : { text: value.label };

  return (
    <QuestionCard
      answered={given ? asAnswer(given) : undefined}
      footer={
        error ? (
          <p className="text-destructive text-sm" role="alert">
            {ui.reason(error)}
          </p>
        ) : null
      }
      onDismiss={given ? undefined : onDismiss}
      onOwnAnswer={
        open
          ? (text) => void answer({ choice: text, label: text, typed: true })
          : undefined
      }
      onPick={
        open
          ? (option) => void answer({ choice: option.id, label: option.label })
          : undefined
      }
      options={options}
      screen={
        status === "inProgress" ? undefined : (
          <QuestionScreen
            computerId={conversation?.botId}
            toolCallId={props.toolCallId}
            waiting={!given}
          />
        )
      }
      sending={sending ? asAnswer(sending) : undefined}
      subtitle={
        status === "inProgress"
          ? (args.summary ?? ui.preparingQuestion)
          : args.summary
      }
      title={args.title || ui.waitingForBot}
    />
  );
}

/**
 * A decision card drawn from the server's record of it, for a tab whose transcript does not hold
 * the question (`PendingRequests`). Answered here, the answer goes to the tab holding the run, or as
 * a message when no tab holds it any more.
 */
export function RecordedDecision({ record }: { record: WaitingDecision }) {
  if (record.kind === "approval")
    return (
      <ApprovalCard
        args={approvalArgsOf(record.args)}
        record={record}
        respond={async () => {}}
        result={undefined}
        status="executing"
        toolCallId={record.toolCallId}
      />
    );
  return (
    <ChoiceCard
      args={choiceArgsOf(record.args)}
      record={record}
      respond={async () => {}}
      result={undefined}
      status="executing"
      toolCallId={record.toolCallId}
    />
  );
}

/** An answer said in the chat, as the option whose label it is, or as words of the person's own. */
function choiceFromText(
  text: string,
  options: ReadonlyArray<{ id?: string; label?: string } | undefined>,
): ChoiceAnswer {
  const picked = options.find((option) => option?.label === text);
  return picked?.id
    ? { choice: picked.id, label: text }
    : { choice: text, label: text, typed: true };
}

/**
 * An approval said in the chat. The card sends a row's label, with the reason after a colon when one
 * was typed; anything else is the person's own words, drawn as they wrote them rather than guessed
 * into a yes or a no.
 */
function approvalFromText(
  text: string,
  approveLabel: string,
  rejectLabel: string,
): ApprovalAnswer | { text: string } {
  for (const [label, decision] of [
    [approveLabel, "approved"],
    [rejectLabel, "declined"],
  ] as const) {
    if (text === label) return { decision };
    if (text.startsWith(`${label}: `))
      return { decision, note: text.slice(label.length + 2) };
  }
  return { text };
}

/**
 * Read completed answers defensively from the runtime's serialized tool result.
 */
function readResult(
  result: string | undefined,
): Record<string, unknown> | undefined {
  if (!result) return undefined;
  try {
    const parsed = JSON.parse(result);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readApproval(result: string | undefined): ApprovalAnswer | undefined {
  const recorded = readResult(result);
  const decision = recorded?.decision;
  if (decision !== "approved" && decision !== "declined") return undefined;
  const note =
    typeof recorded?.note === "string" && recorded.note
      ? recorded.note
      : undefined;
  return note ? { decision, note } : { decision };
}

/** The recorded answer, typed or picked, or nothing for a result that does not hold one. */
function readChoiceAnswer(
  result: string | undefined,
): ChoiceAnswer | undefined {
  const recorded = readResult(result);
  const choice = recorded?.choice;
  if (typeof choice !== "string") return undefined;
  const label = typeof recorded?.label === "string" ? recorded.label : choice;
  return recorded?.typed === true
    ? { choice, label, typed: true }
    : { choice, label };
}

/**
 * `kind: "decision"` is what makes these suspend the run: they are registered with
 * `useHumanInTheLoop` rather than as ordinary tools, and the person's answer IS the tool result, so
 * there is no confirmation line to give the model.
 */
export const GALLERY: GalleryComponent[] = [
  {
    name: "askApproval",
    title: "Approval",
    kind: "decision",
    description:
      "Ask the person to approve or decline something, and WAIT for their answer. Use before doing anything you cannot undo, spending money, sending a message, changing a record. You are given their decision and any reason they typed.",
    parameters: ApprovalCardProps,
    Component: ApprovalCard as GalleryComponent["Component"],
    preview: {
      // The whole interaction, because that is what this component is handed: it suspends a run,
      // so its arguments arrive wrapped in the state of the decision it is waiting on.
      status: "executing",
      args: {
        title: "Refund this order?",
        summary:
          "The customer was charged twice for the same order and the second charge has not settled.",
        details: [
          { label: "Amount", value: "$128.40" },
          { label: "Customer", value: "Northwind Traders" },
          { label: "Order", value: "2043" },
        ],
        approveLabel: "Refund",
      },
      respond: async () => {},
    },
  },
  {
    name: "askChoice",
    title: "Choice",
    kind: "decision",
    description:
      "Ask the person to pick one of several options, and WAIT for their answer. Use when you cannot sensibly guess which one they meant. You are given the id of the option they chose, or, when they typed an answer of their own instead, their words with typed: true.",
    parameters: ChoiceCardProps,
    Component: ChoiceCard as GalleryComponent["Component"],
    preview: {
      status: "executing",
      args: {
        title: "Which environment should this go to?",
        summary: "The build is green and nothing else is queued.",
        options: [
          {
            id: "staging",
            label: "Staging",
            description: "Safe, and reversible",
          },
          {
            id: "production",
            label: "Production",
            description: "Live customers",
          },
        ],
      },
      respond: async () => {},
    },
  },
];
