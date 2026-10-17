import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type QuestionAnswer,
  QuestionCard,
} from "@/components/chat-cards/question-card";
import { isStandIn } from "@/lib/copilot/repair-history";
import { useTranslation } from "@/lib/i18n";
import { useContentText } from "@/lib/i18n/content";
import {
  type AddedItem,
  type MarketplaceItem,
  type MarketplaceOfferAnswer,
  marketplaceAnswer,
  readMarketplaceAnswer,
  readTemplateAnswer,
  type TemplateApplied,
  type TemplateOfferAnswer,
  templateAnswer,
} from "@/lib/suggestions/offers";

/**
 * A Bot offering the person a Bot template or a Marketplace item, drawn as the question card every
 * question shares: what is offered as the question, what it is under it, Yes and No as rows A and B,
 * and a field for an answer of their own.
 *
 * THE CARD IS THE TOOL. `offer_bot_template` and `offer_marketplace_item` have no handler: the run
 * suspends here and nothing changes until a row is picked. What it offers is this deployment's
 * description of the template or item, read by id, never the model's wording — the Bot names the
 * thing and gives a reason, and the card says what it is and what pressing does.
 *
 * Writing is a prop (`apply`, `add`, `openConnect`), so the cards are exercised without a transport.
 * A refusal from the server stays on the card with the rows still live, the way the coworker card
 * keeps one: answering the tool with an error would end the turn at the moment the person could
 * fix it and press again.
 */

type Respond = (result: unknown) => Promise<void>;

const APPLY = "apply";
const ADD = "add";
const CONNECT = "connect";
const DECLINE = "decline";

/** A template as the card draws it. */
export type OfferedTemplate = { id: string; name: string; summary: string };

export type OfferTemplateArgs = { templateId: string; reason?: string };

export function OfferTemplateCard({
  args,
  template,
  failed,
  respond: liveRespond,
  result,
  say,
  apply,
}: {
  /** Partial while the model is still writing the call. */
  args: Partial<OfferTemplateArgs>;
  /** Undefined while loading, null when this deployment has no such template. */
  template: OfferedTemplate | null | undefined;
  /** The templates could not be read, so there is nothing to show but a way to answer. */
  failed?: boolean;
  respond?: Respond;
  result?: string;
  /** Says an answer as the person's message, for a card whose run is no longer live here. */
  say?: Say;
  apply: () => Promise<TemplateApplied>;
}) {
  const { t } = useTranslation();
  const content = useContentText();
  const [sending, setSending] = useState<string | null>(null);
  const [done, setDone] = useState<TemplateOfferAnswer | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const templateId = args.templateId ?? "";
  const respond = replyFor(
    liveRespond,
    say,
    result,
    template?.name ?? templateId,
    t,
  );
  const title = template
    ? t("Apply the {{name}} template?", { name: template.name })
    : t("Apply a template?");
  const rows = [
    { id: APPLY, label: t("Apply it") },
    { id: DECLINE, label: t("No") },
  ];

  const answered = readTemplateAnswer(result) ?? done;
  if (answered) {
    if (answered.outcome === "unavailable") {
      return (
        <QuestionCard
          subtitle={t("That template is not here any more.")}
          title={title}
        />
      );
    }
    return (
      <QuestionCard
        answered={
          answered.outcome === "answered"
            ? { text: answered.text }
            : { optionId: answered.outcome === "applied" ? APPLY : DECLINE }
        }
        options={rows}
        title={title}
      />
    );
  }

  if (isStandIn(result)) {
    return (
      <QuestionCard
        subtitle={t("Answered in the conversation.")}
        title={title}
      />
    );
  }
  if (!respond) {
    return <QuestionCard subtitle={t("Choosing a template…")} title={title} />;
  }
  if (template === null) {
    return (
      <AnswerOnce
        answer={templateAnswer.unavailable(templateId)}
        respond={respond}
        subtitle={t("That template is not here any more.")}
        title={title}
      />
    );
  }

  const send = async (key: string, answer: TemplateOfferAnswer) => {
    setSending(key);
    await answerWith(respond, answer);
    setDone(answer);
  };
  const decline = () =>
    send(
      DECLINE,
      templateAnswer.declined(templateId, template?.name ?? templateId),
    );
  const own = (text: string) =>
    send("own", templateAnswer.answered(templateId, text));

  if (template === undefined) {
    return (
      <QuestionCard
        onOwnAnswer={failed ? (text) => void own(text) : undefined}
        onPick={failed ? () => void decline() : undefined}
        options={failed ? [{ id: DECLINE, label: t("No") }] : []}
        subtitle={
          failed
            ? t("This template couldn't be loaded.")
            : t("Loading the template…")
        }
        title={title}
      />
    );
  }

  const applyIt = async () => {
    setSending(APPLY);
    setRefusal(null);
    let applied: TemplateApplied;
    try {
      applied = await apply();
    } catch (cause) {
      setSending(null);
      setRefusal(
        cause instanceof Error && cause.message
          ? cause.message
          : t("The template could not be applied."),
      );
      return;
    }
    const answer = templateAnswer.applied(templateId, template.name, applied);
    await answerWith(respond, answer);
    setDone(answer);
  };

  return (
    <QuestionCard
      footer={<Refusal text={refusal} />}
      onOwnAnswer={(text) => void own(text)}
      onPick={(option) => void (option.id === APPLY ? applyIt() : decline())}
      options={rows}
      sending={sendingAnswer(sending)}
      subtitle={content(template.summary)}
      title={title}
    >
      <Reason text={args.reason} />
      <p className="text-muted-foreground text-sm">
        {t(
          "It gives this Bot the template's instructions, title and skills. Its name and avatar change only if you have not chosen your own.",
        )}
      </p>
    </QuestionCard>
  );
}

export type OfferMarketplaceArgs = { id: string; reason: string };

export function OfferMarketplaceCard({
  args,
  item,
  failed,
  respond: liveRespond,
  result,
  say,
  add,
  openConnect,
}: {
  args: Partial<OfferMarketplaceArgs>;
  /** Undefined while loading, null when the Marketplace offers nothing by that id here. */
  item: MarketplaceItem | null | undefined;
  failed?: boolean;
  respond?: Respond;
  result?: string;
  /** Says an answer as the person's message, for a card whose run is no longer live here. */
  say?: Say;
  add: () => Promise<AddedItem>;
  /** Goes to the page where the person connects it: the plugin's page, or their account's. */
  openConnect: () => void;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState<string | null>(null);
  const [done, setDone] = useState<MarketplaceOfferAnswer | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const id = args.id ?? "";
  const name = item?.name ?? id;
  const respond = replyFor(liveRespond, say, result, name, t);
  const connecting = item?.eligibility === "needs-account";
  const title = !item
    ? t("Looking this up in the Marketplace…")
    : connecting
      ? t("{{name}} is available in the Marketplace.", { name })
      : t("{{name}} is available in the Marketplace. Add it to this Bot?", {
          name,
        });
  const rows = [
    connecting
      ? { id: CONNECT, label: t("Open to connect") }
      : { id: ADD, label: t("Add it") },
    { id: DECLINE, label: t("No") },
  ];

  /** Nothing to offer: already on this Bot, or not something the Marketplace has here. */
  const unavailableTitle = item?.held
    ? t("{{name}} is already on this Bot.", { name })
    : t("The Marketplace does not offer that here.");

  const answered = readMarketplaceAnswer(result) ?? done;
  if (answered) {
    if (answered.outcome === "unavailable") {
      return <QuestionCard title={unavailableTitle} />;
    }
    const pick: QuestionAnswer =
      answered.outcome === "answered"
        ? { text: answered.text }
        : {
            optionId:
              answered.outcome === "added"
                ? ADD
                : answered.outcome === "connect-offered"
                  ? CONNECT
                  : DECLINE,
          };
    return (
      <QuestionCard
        answered={pick}
        footer={
          answered.outcome === "connect-offered" && item ? (
            <button
              className="text-sm underline underline-offset-4"
              onClick={openConnect}
              type="button"
            >
              {t("Open to connect")}
            </button>
          ) : null
        }
        // Every row there could have been: read back after a reload, the item may still be loading.
        options={[
          { id: ADD, label: t("Add it") },
          { id: CONNECT, label: t("Open to connect") },
          { id: DECLINE, label: t("No") },
        ]}
        title={title}
      />
    );
  }

  if (isStandIn(result)) {
    return (
      <QuestionCard
        subtitle={t("Answered in the conversation.")}
        title={title}
      />
    );
  }
  if (!respond) {
    return (
      <QuestionCard
        subtitle={t("Looking this up in the Marketplace…")}
        title={title}
      />
    );
  }
  if (item === null || item?.held) {
    return (
      <AnswerOnce
        answer={marketplaceAnswer.unavailable(id, Boolean(item?.held))}
        respond={respond}
        title={unavailableTitle}
      />
    );
  }

  const send = async (key: string, answer: MarketplaceOfferAnswer) => {
    setSending(key);
    await answerWith(respond, answer);
    setDone(answer);
  };
  const decline = () => send(DECLINE, marketplaceAnswer.declined({ id, name }));
  const own = (text: string) =>
    send("own", marketplaceAnswer.answered(id, text));

  if (item === undefined) {
    return (
      <QuestionCard
        onOwnAnswer={failed ? (text) => void own(text) : undefined}
        onPick={failed ? () => void decline() : undefined}
        options={failed ? [{ id: DECLINE, label: t("No") }] : []}
        subtitle={
          failed
            ? t("That Marketplace item could not be read.")
            : t("Looking this up in the Marketplace…")
        }
        title={title}
      />
    );
  }

  const addIt = async () => {
    setSending(ADD);
    setRefusal(null);
    let outcome: AddedItem;
    try {
      outcome = await add();
    } catch (cause) {
      setSending(null);
      setRefusal(
        cause instanceof Error && cause.message
          ? cause.message
          : t("That plugin could not be added."),
      );
      return;
    }
    const answer = marketplaceAnswer.added(item, outcome);
    await answerWith(respond, answer);
    setDone(answer);
  };

  /** Answered first, so the Bot's turn carries on, then the page opens. Nothing is installed. */
  const connect = async () => {
    await send(CONNECT, marketplaceAnswer.connectOffered(item));
    openConnect();
  };

  return (
    <QuestionCard
      footer={<Refusal text={refusal} />}
      onOwnAnswer={(text) => void own(text)}
      onPick={(option) =>
        void (option.id === ADD
          ? addIt()
          : option.id === CONNECT
            ? connect()
            : decline())
      }
      options={rows}
      sending={sendingAnswer(sending)}
      subtitle={item.summary}
      title={title}
    >
      <Reason text={args.reason} />
      <p className="text-muted-foreground text-sm">
        {item.eligibility === "needs-account"
          ? t(
              "It needs an account of yours before this Bot can use it, so nothing is added from here. Open it to connect your account.",
            )
          : item.eligibility === "optional"
            ? t(
                "Its skills work as soon as it is added. Connecting an account to it later in the Marketplace unlocks more.",
              )
            : t("It works as soon as it is added.")}
      </p>
    </QuestionCard>
  );
}

/** The Bot's reason for offering, in its own words, when it gave one. */
function Reason({ text }: { text?: string }) {
  const reason = text?.trim();
  return reason ? <p className="mb-2 text-sm">{reason}</p> : null;
}

function Refusal({ text }: { text: string | null }): ReactNode {
  return text ? (
    <p className="text-destructive text-sm" role="alert">
      {text}
    </p>
  ) : null;
}

/** The row working while an answer leaves; typed words show on the field, not a row. */
function sendingAnswer(key: string | null): QuestionAnswer | undefined {
  if (key === null) return undefined;
  return key === "own" ? { text: "" } : { optionId: key };
}

/**
 * An offer with nothing to ask: answered once, so the run does not wait on a card nobody can
 * answer, and drawn so the transcript has no gap where an offer nearly was. Guarded by a ref, since
 * the queries behind the card poll and would otherwise answer again on each refetch.
 */
function AnswerOnce({
  answer,
  respond,
  title,
  subtitle,
}: {
  answer: TemplateOfferAnswer | MarketplaceOfferAnswer;
  respond: Respond;
  title: string;
  subtitle?: string;
}) {
  const answered = useRef(false);
  useEffect(() => {
    if (answered.current) return;
    answered.current = true;
    void answerWith(respond, answer);
  }, [answer, respond]);
  return <QuestionCard subtitle={subtitle} title={title} />;
}

/**
 * Answering, with a failure to answer swallowed: `respond` only rejects for a run that has already
 * ended (a reload, a stop, an answer from another tab), and by then the choice is made either way.
 */
type Say = (text: string) => Promise<unknown>;

/**
 * An answer as the person would say it, or nothing for an offer that was not there to answer.
 * Applying and adding are done from the card before this is said, so it says they are done.
 */
export function spokenAnswer(
  answer: TemplateOfferAnswer | MarketplaceOfferAnswer,
  name: string,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  switch (answer.outcome) {
    case "applied":
      return t("I applied the {{name}} template.", { name });
    case "added":
      return t("I added {{name}} to this Bot.", { name });
    case "connect-offered":
      return t("I'll connect {{name}} myself.", { name });
    case "declined":
      return t("No, thanks.");
    case "answered":
      return answer.text;
    default:
      return null;
  }
}

/**
 * How the card answers: on the live run when this tab holds it, else as the person's next message.
 *
 * A card read back after a reload, or in another tab, has no run to answer, and it was a card with
 * a question on it and nothing to press. Now its rows still work: Yes still applies or adds, from
 * here, and the answer goes to the Bot as what the person says. Once the conversation has moved on
 * past it (its result is a stand-in), there is nothing left to answer.
 */
function replyFor(
  live: Respond | undefined,
  say: Say | undefined,
  result: string | undefined,
  name: string,
  t: ReturnType<typeof useTranslation>["t"],
): Respond | undefined {
  if (live) return live;
  if (!say || isStandIn(result)) return undefined;
  return async (answer) => {
    const text = spokenAnswer(
      answer as TemplateOfferAnswer | MarketplaceOfferAnswer,
      name,
      t,
    );
    if (text) await say(text);
  };
}

async function answerWith(respond: Respond, answer: unknown): Promise<void> {
  try {
    await respond(answer);
  } catch {
    // The run this card belonged to is gone. Nothing further to do.
  }
}
