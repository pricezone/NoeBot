import { IconArrowUp, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { Badge, GalleryFrame } from "./frame";

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

export function ApprovalCard(props: Waiting<ApprovalArgs> & { name?: string }) {
  const { args, status, respond } = props;
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<"approved" | "declined" | null>(null);

  const answer = async (decision: "approved" | "declined") => {
    if (!respond) return;
    setSending(decision);
    // Include the note in the same tool result that resumes the Bot.
    await respond({ decision, note: note.trim() || undefined });
  };

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args.title ?? "Waiting for the assistant…"}>
        <p className="text-sm text-muted-foreground">Preparing the request…</p>
      </GalleryFrame>
    );
  }

  const decided =
    status === "complete" ? readDecision(props.result) : undefined;

  return (
    <GalleryFrame
      action={
        decided ? (
          <Badge tone={decided === "approved" ? "positive" : "negative"}>
            {decided === "approved" ? "Approved" : "Declined"}
          </Badge>
        ) : (
          <Badge tone="caution">Waiting on you</Badge>
        )
      }
      title={args.title}
    >
      <p className="text-sm">{args.summary}</p>

      {args.details?.length ? (
        <dl className="mt-3 grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-1.5 text-sm">
          {args.details.map((detail) => (
            <div className="contents" key={detail.label}>
              <dt className="truncate text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {decided ? null : (
        <div className="mt-4 space-y-2">
          <input
            aria-label="A reason, if you want to give one"
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm"
            disabled={Boolean(sending)}
            onChange={(event) => setNote(event.target.value)}
            placeholder="A reason, if you want to give one"
            value={note}
          />
          <div className="flex gap-2">
            <Button
              disabled={Boolean(sending)}
              onClick={() => void answer("approved")}
              size="sm"
            >
              {sending === "approved"
                ? "Sending…"
                : (args.approveLabel ?? "Approve")}
            </Button>
            <Button
              disabled={Boolean(sending)}
              onClick={() => void answer("declined")}
              size="sm"
              variant="outline"
            >
              {sending === "declined"
                ? "Sending…"
                : (args.rejectLabel ?? "Decline")}
            </Button>
          </div>
        </div>
      )}
    </GalleryFrame>
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

/** A, B, C… for the rows, and past Z the row's number, so a long list still has a name per row. */
function letterFor(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/**
 * The answer a person gave, in the shape it is recorded: the option's id, or — for an answer they
 * typed themselves — their words, marked as typed. One shape for both, so a reader of the result
 * never has to learn a second one.
 */
export type ChoiceAnswer = { choice: string; label: string; typed?: true };

/**
 * A question with lettered options and a last row for an answer of the person's own.
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
  /** The option id or typed words on their way out, so the card stops taking answers at once. */
  const [sending, setSending] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  const recorded =
    status === "complete" ? readChoiceAnswer(props.result) : undefined;
  const chosen = recorded?.choice ?? sending ?? undefined;
  const options = args.options ?? [];
  const pickedOption = options.find((option) => option.id === chosen);
  /** An answer that is none of the options: what the person typed. */
  const ownAnswer =
    chosen !== undefined && !pickedOption
      ? (recorded?.label ?? chosen)
      : undefined;
  const settled = chosen !== undefined || status !== "executing";

  const answer = async (value: ChoiceAnswer) => {
    if (!respond || settled) return;
    setSending(value.choice);
    try {
      await respond(value);
    } catch {
      // Not sent, so not answered: the card takes an answer again.
      setSending(null);
    }
  };

  const submitOwn = () => {
    const text = draft.trim();
    if (!text) return;
    void answer({ choice: text, label: text, typed: true });
  };

  return (
    <figure className="my-2 w-full max-w-2xl rounded-2xl bg-muted p-4 dark:bg-card">
      <figcaption className="flex items-start justify-between gap-4 pb-3">
        <div className="min-w-0">
          <p className="text-[15px] font-medium">
            {args.title ?? "Waiting for the assistant…"}
          </p>
          {args.summary ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {args.summary}
            </p>
          ) : null}
        </div>
        {recorded ? (
          <Badge tone="positive">Answered</Badge>
        ) : onDismiss && !settled ? (
          <button
            aria-label="Dismiss"
            className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            onClick={onDismiss}
            type="button"
          >
            <IconX className="size-4" />
          </button>
        ) : null}
      </figcaption>

      {status === "inProgress" ? (
        <p className="text-sm text-muted-foreground">Preparing the question…</p>
      ) : (
        <>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-background">
            {options.map((option, index) => {
              const picked = pickedOption?.id === option.id;
              return (
                <li key={option.id}>
                  <button
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors ${
                      picked
                        ? "bg-emerald-500/10"
                        : settled
                          ? "opacity-50"
                          : "hover:bg-foreground/5"
                    }`}
                    disabled={settled}
                    onClick={() =>
                      void answer({ choice: option.id, label: option.label })
                    }
                    type="button"
                  >
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border text-xs text-muted-foreground"
                    >
                      {letterFor(index)}
                    </span>
                    <span className="min-w-0">
                      <span className="block">{option.label}</span>
                      {option.description ? (
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {ownAnswer !== undefined ? (
            <p className="mt-3 rounded-xl border border-border bg-emerald-500/10 px-3 py-2.5 text-sm">
              {ownAnswer}
            </p>
          ) : typing && !settled ? (
            <form
              className="mt-3 flex items-center gap-2 rounded-xl border border-ring bg-background px-3 py-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                submitOwn();
              }}
            >
              <input
                aria-label="Your own answer"
                // Opened by a click on the row it replaced, so the caret belongs here at once.
                // biome-ignore lint/a11y/noAutofocus: the person just asked to type.
                autoFocus
                className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setTyping(false);
                  }
                }}
                placeholder="Type your own answer"
                value={draft}
              />
              <Button
                aria-label="Send answer"
                disabled={!draft.trim()}
                size="icon-xs"
                type="submit"
              >
                <IconArrowUp />
              </Button>
            </form>
          ) : settled ? null : (
            <button
              className="mt-3 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-foreground/5"
              onClick={() => setTyping(true)}
              type="button"
            >
              Type your own answer
            </button>
          )}
        </>
      )}
    </figure>
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

function readDecision(
  result: string | undefined,
): "approved" | "declined" | undefined {
  const value = readResult(result)?.decision;
  return value === "approved" || value === "declined" ? value : undefined;
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
