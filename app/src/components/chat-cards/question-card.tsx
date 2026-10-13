import {
  IconArrowUp,
  IconCheck,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Every question a Bot puts to a person in the chat, and every confirmation it waits on, drawn one
 * way: a bold question, a muted line under it, lettered rows to pick from and, where words are a
 * fair answer, a field to type one's own.
 *
 * ONE CARD, BECAUSE THE PERSON SEES ONE KIND OF THING. A choice, an approval, a computer action
 * waiting on them, a Team Bot asking for their account, a coworker or skill to create: each used to
 * be drawn by its own component, with its own buttons, badges and answered state, so the same
 * moment — "the Bot is waiting on you" — looked different every time it came up. The callers keep
 * what is theirs (what is asked, what an answer sends, what happens after) and hand this the rows.
 *
 * ANSWERED, IT COLLAPSES to the question and the one row that was chosen, with a check. The options
 * not taken are history nobody needs to scroll past, and a dimmed list of them reads as if it might
 * still be live.
 *
 * Letter keys pick a row while the card has focus (a row, the X), never from the page at large: a
 * transcript can hold several cards, and a shortcut on the document would steal the letters someone
 * is typing into the composer.
 */

export type QuestionOption = {
  /** What the caller gets back when this row is picked. */
  id: string;
  label: string;
  description?: ReactNode;
};

/** What was answered: one of the rows (and a note, drawn under it), or words of the person's own. */
export type QuestionAnswer =
  | { optionId: string; note?: ReactNode }
  | { text: string };

/** A, B, C… for the rows, and past Z the row's number, so a long list still has a name per row. */
export function letterFor(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

export function QuestionCard({
  title,
  subtitle,
  children,
  options = [],
  onPick,
  onOwnAnswer,
  answered,
  sending,
  onDismiss,
  footer,
  label,
}: {
  title: ReactNode;
  /** The muted line under the question: why it is asked, or what answering does. */
  subtitle?: ReactNode;
  /** Anything the person needs in order to answer, drawn under the subtitle while the card is open. */
  children?: ReactNode;
  options?: readonly QuestionOption[];
  /**
   * Answering with a row. Absent, the rows are drawn but take no answer — a card still being
   * written, or one previewed in the gallery.
   *
   * Handed what is in the own-answer field too, for a card whose typed words travel with the row
   * picked (an approval's reason) rather than standing alone as the answer.
   */
  onPick?: (option: QuestionOption, typed: string) => void;
  /** Puts the "Type your own answer" field under the rows; Enter or the arrow sends the words. */
  onOwnAnswer?: (text: string) => void;
  /** The answer once there is one: the card collapses to the question and this row. */
  answered?: QuestionAnswer;
  /** An answer on its way out. The card takes no other meanwhile, and the row shows it is working. */
  sending?: QuestionAnswer;
  /** An X at the top right, for a question the person may wave away and answer some other way. */
  onDismiss?: () => void;
  /** Drawn under the rows, open or answered: an error, a link to what the answer made. */
  footer?: ReactNode;
  /** The card's accessible name. Defaults to the question itself. */
  label?: string;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState("");
  const busy = sending !== undefined;
  const live = !answered && !busy && Boolean(onPick);

  const pick = (option: QuestionOption) => {
    if (!live || !onPick) return;
    onPick(option, draft.trim());
  };

  const submitOwn = () => {
    const text = draft.trim();
    if (!text || answered || busy || !onOwnAnswer) return;
    onOwnAnswer(text);
  };

  /** A letter picks its row, unless it is being typed into the field. */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!live || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key.length !== 1) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true']")) return;
    const index = event.key.toUpperCase().charCodeAt(0) - 65;
    const option = index >= 0 && index < 26 ? options[index] : undefined;
    if (!option) return;
    event.preventDefault();
    pick(option);
  };

  return (
    <section
      aria-label={label}
      aria-labelledby={label ? undefined : titleId}
      className="my-2 w-full max-w-2xl rounded-2xl bg-muted p-4 dark:bg-card"
      onKeyDown={onKeyDown}
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p
            className="break-words font-semibold text-[17px] leading-snug"
            id={titleId}
          >
            {title}
          </p>
          {subtitle && !answered ? (
            <p className="mt-1 break-words text-[15px] text-muted-foreground leading-snug">
              {subtitle}
            </p>
          ) : null}
        </div>
        {onDismiss && !answered && !busy ? (
          <button
            aria-label="Dismiss"
            className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={onDismiss}
            type="button"
          >
            <IconX className="size-4" />
          </button>
        ) : null}
      </header>

      {answered ? (
        <AnsweredRow answer={answered} options={options} />
      ) : (
        <>
          {children ? <div className="mt-3">{children}</div> : null}

          {options.length > 0 ? (
            <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl bg-background dark:bg-muted">
              {options.map((option, index) => {
                const working =
                  sending && "optionId" in sending
                    ? sending.optionId === option.id
                    : false;
                // Named by its label; the description is read after it, not as part of the name.
                const rowId = `${titleId}-option-${index}`;
                const describedBy = option.description
                  ? `${rowId}-description`
                  : undefined;
                return (
                  <li key={option.id}>
                    <button
                      aria-busy={working || undefined}
                      aria-describedby={describedBy}
                      aria-labelledby={
                        describedBy ? `${rowId}-label` : undefined
                      }
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-2.5 text-left text-[15px] outline-none transition-colors",
                        live
                          ? "hover:bg-foreground/5 focus-visible:bg-foreground/5"
                          : "cursor-default",
                        busy && !working ? "opacity-50" : "",
                      )}
                      disabled={!live}
                      onClick={() => pick(option)}
                      type="button"
                    >
                      <LetterBadge letter={letterFor(index)} />
                      <RowText
                        description={option.description}
                        descriptionId={describedBy}
                        label={option.label}
                        labelId={describedBy ? `${rowId}-label` : undefined}
                      />
                      {working ? (
                        <IconLoader2
                          aria-hidden
                          className="size-4 shrink-0 animate-spin text-muted-foreground"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {onOwnAnswer ? (
            <form
              className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-1.5 transition-colors focus-within:border-ring dark:bg-transparent"
              onSubmit={(event) => {
                event.preventDefault();
                submitOwn();
              }}
            >
              <input
                aria-label="Your own answer"
                className="min-w-0 flex-1 bg-transparent py-1 text-[15px] outline-none placeholder:text-muted-foreground"
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type your own answer"
                value={draft}
              />
              <Button
                aria-label="Send answer"
                disabled={busy || !draft.trim()}
                size="icon-xs"
                type="submit"
              >
                {sending && "text" in sending ? (
                  <IconLoader2 className="animate-spin" />
                ) : (
                  <IconArrowUp />
                )}
              </Button>
            </form>
          ) : null}
        </>
      )}

      {footer ? <div className="mt-3">{footer}</div> : null}
    </section>
  );
}

/** The one row left once the card is answered: the pick, or the typed words, and a check. */
function AnsweredRow({
  answer,
  options,
}: {
  answer: QuestionAnswer;
  options: readonly QuestionOption[];
}) {
  const index =
    "optionId" in answer
      ? options.findIndex((option) => option.id === answer.optionId)
      : -1;
  const option = index === -1 ? undefined : options[index];
  const text =
    option?.label ?? ("text" in answer ? answer.text : answer.optionId);
  const note = "optionId" in answer ? answer.note : undefined;
  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl bg-background px-3 py-2.5 text-[15px] text-muted-foreground dark:bg-muted">
      {option ? <LetterBadge letter={letterFor(index)} /> : null}
      <RowText description={note} label={text} />
      <IconCheck
        aria-label="Answered"
        className="size-4 shrink-0 text-foreground"
        role="img"
      />
    </div>
  );
}

function LetterBadge({ letter }: { letter: string }) {
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted font-medium text-muted-foreground text-xs dark:bg-foreground/10"
    >
      {letter}
    </span>
  );
}

function RowText({
  label,
  labelId,
  description,
  descriptionId,
}: {
  label: string;
  labelId?: string;
  description?: ReactNode;
  descriptionId?: string;
}) {
  return (
    <span className="min-w-0 flex-1 break-words">
      <span className="block" id={labelId}>
        {label}
      </span>
      {description ? (
        <span
          className="mt-0.5 block text-muted-foreground text-xs"
          id={descriptionId}
        >
          {description}
        </span>
      ) : null}
    </span>
  );
}
