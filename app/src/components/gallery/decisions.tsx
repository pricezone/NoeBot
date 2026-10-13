import { useState } from "react";
import { z } from "zod";
import {
  type QuestionAnswer,
  QuestionCard,
} from "@/components/chat-cards/question-card";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";

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

/**
 * Approve or decline, drawn as the question card: the request as its question, the summary and the
 * facts under it, Approve and Decline as rows A and B.
 *
 * The field under the rows is the reason. Typed and then a row picked, it travels with that
 * decision, as the reason box always did. Typed and sent on its own it is an answer that is not
 * "approve", so it goes out as a decline carrying the person's words: the Bot learns what they want
 * instead, and nothing irreversible happens on an answer that never said yes.
 */
export function ApprovalCard(props: Waiting<ApprovalArgs> & { name?: string }) {
  const { args, status, respond } = props;
  const [sending, setSending] = useState<ApprovalAnswer | null>(null);
  const [sent, setSent] = useState<ApprovalAnswer | null>(null);

  if (status === "inProgress") {
    return (
      <QuestionCard
        subtitle="Preparing the request…"
        title={args.title ?? "Waiting for the assistant…"}
      />
    );
  }

  const decided =
    (status === "complete" ? readApproval(props.result) : undefined) ??
    sent ??
    undefined;

  const answer = async (decision: ApprovalAnswer["decision"], note: string) => {
    if (!respond || sending || decided) return;
    // Include the note in the same tool result that resumes the Bot.
    const value = { decision, note: note.trim() || undefined };
    setSending(value);
    try {
      await respond(value);
      setSent(value);
    } catch {
      // Not sent, so not decided: the card takes an answer again.
    } finally {
      setSending(null);
    }
  };

  const options = [
    { id: "approved", label: args.approveLabel ?? "Approve" },
    { id: "declined", label: args.rejectLabel ?? "Decline" },
  ];
  const asAnswer = (value: ApprovalAnswer): QuestionAnswer => ({
    optionId: value.decision,
    note: value.note,
  });

  return (
    <QuestionCard
      answered={decided ? asAnswer(decided) : undefined}
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
      sending={sending ? asAnswer(sending) : undefined}
      subtitle={args.summary}
      title={args.title}
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
 * then answers in the composer like any other message.
 */
export function ChoiceCard(
  props: Waiting<ChoiceArgs> & { onDismiss?: () => void },
) {
  const { args, status, respond, onDismiss } = props;
  /** The answer on its way out, so the card stops taking answers at once. */
  const [sending, setSending] = useState<ChoiceAnswer | null>(null);
  /** Sent, before the transcript has caught up with it. */
  const [sent, setSent] = useState<ChoiceAnswer | null>(null);

  const recorded =
    status === "complete" ? readChoiceAnswer(props.result) : undefined;
  const given = recorded ?? sent ?? undefined;
  const options = status === "inProgress" ? [] : (args.options ?? []);
  const open = status === "executing" && Boolean(respond) && !given;

  const answer = async (value: ChoiceAnswer) => {
    if (!respond || !open || sending) return;
    setSending(value);
    try {
      await respond(value);
      setSent(value);
    } catch {
      // Not sent, so not answered: the card takes an answer again.
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
      sending={sending ? asAnswer(sending) : undefined}
      subtitle={
        status === "inProgress"
          ? (args.summary ?? "Preparing the question…")
          : args.summary
      }
      title={args.title ?? "Waiting for the assistant…"}
    />
  );
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
