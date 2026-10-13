import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { QuestionCard } from "@/components/chat-cards/question-card";
import type { SkillFormValues } from "@/lib/skills/form";
import {
  checkProposal,
  type ProposedSkill,
  skillCardAnswer,
  wasSaved,
} from "@/lib/skills/proposal";

/**
 * The skill a Bot has written, put in front of the person before it is saved.
 *
 * WHY THERE IS A CARD AT ALL, when a skill adds no capability and anybody signed in may write one.
 * Two reasons, and neither is about permission. The first is authorship: this is a named thing that
 * will appear in everybody's `/` menu with somebody's name on it, and a person should read the
 * instruction their Bot drafted before it starts running on their behalf. The second is the slug:
 * saving is how an edit is spelled, so an unattended save can replace a skill somebody is using.
 *
 * So the whole tool is this card. There is no handler behind it — the run suspends here, and nothing
 * is written until a row is picked. Drawn as the question card everybody's questions share: "Create
 * it" (or "Replace it") and "Don't save" are its rows, and once answered it collapses to the one
 * picked, with the next step under it.
 */

export type ProposedSkillCardProps = {
  /** Partial while the model is still streaming the arguments. */
  args: Partial<ProposedSkill>;
  /**
   * What this slug already names here, when it names something.
   *
   * Drives the wording rather than the outcome — "Replace" instead of "Create", and whose it is.
   * The server decides whether the replacement is allowed and says so in its own words.
   */
  replaces?: { title: string; ownership: string };
  /** Answering resumes the Bot. Absent while streaming, and once this card has been answered. */
  respond?: (result: unknown) => Promise<void>;
  /** The recorded answer, once there is one. Completed cards show it instead of controls. */
  result?: string;
  save: (values: SkillFormValues) => Promise<void>;
};

/** The two rows, and the answer each one is. */
const SAVE = "save";
const DECLINE = "decline";
type Choice = typeof SAVE | typeof DECLINE;

export function ProposedSkillCard({
  args,
  replaces,
  respond,
  result,
  save,
}: ProposedSkillCardProps) {
  const [sending, setSending] = useState<Choice | null>(null);
  /**
   * Answered, before the recorded result has come back to say so — and for good when it never does,
   * because the run this card belonged to has gone (see `answer`).
   */
  const [done, setDone] = useState<Choice | null>(null);
  /**
   * A refusal from the server, kept on the card rather than answered with.
   *
   * The run stays suspended, because the two things worth doing next both need it to be — pressing
   * Create again after connecting the connector the refusal named, or declining. Answering the tool
   * with the error would end the turn and leave the person re-typing their request.
   */
  const [refusal, setRefusal] = useState<string | null>(null);
  const title = titleFor(args.slug, replaces);
  const rows = [
    { id: SAVE, label: replaces ? "Replace it" : "Create it" },
    { id: DECLINE, label: "Don't save" },
  ];

  if (result !== undefined || done) {
    const choice =
      result === undefined
        ? done
        : wasSaved(result)
          ? SAVE
          : result === skillCardAnswer.declined()
            ? DECLINE
            : null;
    if (!choice) {
      // Answered without asking anybody: a draft that was not a valid skill.
      return <QuestionCard subtitle={result} title={title} />;
    }
    return (
      <QuestionCard
        answered={{ optionId: choice }}
        footer={
          // Off the recorded answer only, as before: it is what a reload has to go on.
          result !== undefined && wasSaved(result) && args.slug ? (
            <PutItOnABot slug={args.slug} />
          ) : null
        }
        options={rows}
        title={title}
      />
    );
  }

  if (!respond) {
    return <QuestionCard subtitle="Writing the skill…" title={title} />;
  }

  const checked = checkProposal(args);
  if (!checked.ok) {
    return <Unwritable problems={checked.problems} respond={respond} />;
  }
  const values = checked.values;

  const create = async () => {
    setSending(SAVE);
    setRefusal(null);
    try {
      await save(values);
    } catch (cause) {
      // Left on the card with the rows still live. See `refusal` above.
      setSending(null);
      setRefusal(
        cause instanceof Error ? cause.message : "The skill was not saved.",
      );
      return;
    }
    await answer(respond, skillCardAnswer.saved(values.slug));
    setDone(SAVE);
  };

  const decline = async () => {
    setSending(DECLINE);
    await answer(respond, skillCardAnswer.declined());
    setDone(DECLINE);
  };

  return (
    <QuestionCard
      footer={
        refusal ? (
          <p className="text-destructive text-sm" role="alert">
            {refusal}
          </p>
        ) : null
      }
      onPick={(option) => void (option.id === SAVE ? create() : decline())}
      options={rows}
      sending={sending ? { optionId: sending } : undefined}
      subtitle={
        replaces
          ? `This replaces ${replaces.title}, which is ${replaces.ownership}.`
          : "Nothing is saved until you press the button."
      }
      title={titleFor(values.slug, replaces)}
    >
      <dl className="grid grid-cols-[minmax(0,7rem)_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="truncate text-muted-foreground">Command</dt>
        <dd className="min-w-0 break-words font-mono">/{values.slug}</dd>
        <dt className="truncate text-muted-foreground">Title</dt>
        <dd className="min-w-0 break-words">{values.title}</dd>
        {values.summary ? (
          <>
            <dt className="truncate text-muted-foreground">One-liner</dt>
            <dd className="min-w-0 break-words">{values.summary}</dd>
          </>
        ) : null}
        {values.tools.length > 0 ? (
          <>
            <dt className="truncate text-muted-foreground">Needs</dt>
            <dd className="min-w-0 break-words font-mono text-xs">
              {values.tools.join(", ")}
            </dd>
          </>
        ) : null}
      </dl>

      <p className="mt-3 text-muted-foreground text-xs">Instructions</p>
      {/* Scrolled rather than clamped: this is the part worth reading before agreeing to it. */}
      <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 px-3 py-2 text-sm dark:bg-muted/40">
        {values.instructions}
      </p>

      {values.tools.length > 0 ? (
        <p className="mt-2 text-muted-foreground text-xs">
          Naming a tool grants nothing. A Bot is offered these only if an
          administrator has already granted them to it.
        </p>
      ) : null}
    </QuestionCard>
  );
}

function titleFor(
  slug: string | undefined,
  replaces: { title: string } | undefined,
): string {
  const name = slug ? `/${slug}` : "a new skill";
  return replaces ? `Replace ${name}` : `Create ${name}`;
}

/** Where the remaining step happens. A skill on no Bot is inert, and saying so beats implying done. */
function PutItOnABot({ slug }: { slug: string }) {
  return (
    <Link
      className="mt-2 inline-block text-sm underline underline-offset-4"
      search={{ tab: "skills", edit: slug }}
      to="/marketplace"
    >
      Put it on a Bot
    </Link>
  );
}

/**
 * A proposal that cannot be saved as written.
 *
 * Answered rather than shown as a question, because there is nothing for the person to decide: the
 * fields are wrong in a way the model can fix, and the problems name their field so it can. The card
 * still appears, so the transcript does not have a silent gap where a skill was nearly written.
 */
function Unwritable({
  problems,
  respond,
}: {
  problems: string[];
  respond: (result: unknown) => Promise<void>;
}) {
  /**
   * Answered once, guarded by a ref rather than by the dependency list.
   *
   * `problems` is rebuilt from the arguments on every render and the grant queries behind this card
   * poll, so a value-equal array arrives as a new identity every few seconds. Left to the deps, this
   * would answer the same tool call again on each of them.
   */
  const answered = useRef(false);
  useEffect(() => {
    if (answered.current) return;
    answered.current = true;
    void answer(respond, skillCardAnswer.unwritable(problems));
  }, [problems, respond]);

  return (
    <QuestionCard
      subtitle="The Bot's draft was not a valid skill, so nothing was saved. It has been told what to fix."
      title="Skill"
    />
  );
}

/** Resuming a run that is no longer there is not a failure worth reporting: nothing is left to answer. */
function answer(
  respond: (result: unknown) => Promise<void>,
  sentence: string,
): Promise<void> {
  return respond(sentence).catch(() => {});
}
