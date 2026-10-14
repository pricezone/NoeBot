import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageContent,
  MessageHeader,
  Message as MessageRow,
} from "@/components/ui/message";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  addGroupMemberMutationOptions,
  type GroupMessage,
  type GroupPerson,
  groupQueryOptions,
  removeGroupMemberMutationOptions,
  sendGroupMessageMutationOptions,
} from "@/lib/groups";
import { useTranslation } from "@/lib/i18n";
import { useStreamdownTranslations } from "@/lib/i18n/streamdown-translations";
import { markdownComponents } from "@/lib/markdown";
import { newId } from "@/lib/new-id";
import { ChatActivityIndicator } from "./activity-indicator";
import { ChannelAvatar, useAvatarLooks } from "./avatar";
import { BotBubble, GROUP_PERSON_SCHEME, PersonBubble } from "./bubbles";
import { Composer, toAgentOptions } from "./composer";
import { TeamBotConsentCard } from "./team-bot-consent";

/**
 * One conversation with several Bots, read from the server's shared transcript.
 *
 * Not the CopilotKit chat. Each Bot answers in a thread of its own on the server, so there is no one
 * agent for a browser run to bind to; the person posts a message, the server runs every addressed
 * Bot through the ordinary headless AG-UI path, and this draws what each of them said, attributed.
 * `@Name` in the composer addresses one Bot; otherwise every Bot answers, one after another.
 */
export function GroupChat({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const group = useQuery(groupQueryOptions(channelId));
  const me = useQuery(currentUserQueryOptions()).data;
  const send = useMutation(
    sendGroupMessageMutationOptions(queryClient, channelId),
  );
  const bots = group.data?.bots ?? [];
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  const messages = group.data?.messages ?? [];
  const working = messages.some(
    (message) => message.status === "running" || message.status === "queued",
  );

  // Follow the conversation down as lines arrive, the way the single-Bot transcript does.
  const endRef = useRef<HTMLDivElement | null>(null);
  const lastKey = `${messages.length}:${messages.at(-1)?.status ?? ""}`;
  useEffect(() => {
    if (lastKey) endRef.current?.scrollIntoView({ block: "end" });
  }, [lastKey]);

  if (group.isPending) return null;
  if (group.isError)
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {group.error.message}
      </p>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(
                "Say something to {{bots}}. Every Bot answers in turn; start with @Name to ask just one.",
                { bots: bots.map((bot) => bot.name).join(" and ") },
              )}
            </p>
          ) : null}
          {messages.map((message) => (
            <GroupLine
              key={message.id}
              message={message}
              name={
                message.agentId
                  ? (names.get(message.agentId) ?? t("A Bot no longer here"))
                  : message.ownerUserId === me?.id
                    ? t("You")
                    : t("A teammate")
              }
              answeredBy={
                message.answeredBy
                  ? (names.get(message.answeredBy) ?? "another Bot")
                  : undefined
              }
              mine={message.ownerUserId === me?.id}
            />
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        {send.error ? (
          <p className="pb-2 text-sm text-destructive" role="alert">
            {send.error.message}
          </p>
        ) : null}
        <People
          channelId={channelId}
          me={me?.id}
          people={group.data?.people ?? []}
        />
        <AddPerson channelId={channelId} />
        <Composer
          agents={toAgentOptions(bots)}
          commands={[]}
          disabled={bots.length === 0}
          pending={send.isPending || working}
          autoFocus
          onSubmit={async (draft) => {
            if (!draft.text) return;
            await send.mutateAsync({
              id: newId(),
              text: draft.text,
              agentId: draft.agentId,
            });
          }}
        />
      </div>
    </div>
  );
}

/**
 * One attributed line: a person's bubble, and a Bot's named reply on the left.
 *
 * Your own words in the group colour — a conversation with several Bots has no one Bot's colour to
 * borrow — and a teammate's in the muted grey under their name, the way a messages app draws
 * everyone who is not you.
 */
function GroupLine({
  message,
  name,
  answeredBy,
  mine,
}: {
  message: GroupMessage;
  name: string;
  answeredBy?: string;
  mine: boolean;
}) {
  const streamdownTranslations = useStreamdownTranslations();
  const { t } = useTranslation();
  // The status row's character wears the speaking Bot's colour, as its avatar beside it does.
  const lookOf = useAvatarLooks();
  if (message.agentId === null)
    return (
      <MessageRow align={mine ? "end" : "start"}>
        <MessageContent>
          {mine ? null : (
            <MessageHeader className="text-xs font-medium text-muted-foreground">
              {name}
            </MessageHeader>
          )}
          {mine ? (
            <PersonBubble scheme={GROUP_PERSON_SCHEME}>
              <span className="whitespace-pre-wrap">{message.text}</span>
            </PersonBubble>
          ) : (
            <Bubble align="start" variant="muted">
              <BubbleContent>
                <span className="whitespace-pre-wrap">{message.text}</span>
              </BubbleContent>
            </Bubble>
          )}
        </MessageContent>
      </MessageRow>
    );
  return (
    <MessageRow align="start" data-speaker={message.agentId}>
      <div className="shrink-0 pt-0.5">
        <ChannelAvatar participantIds={[message.agentId]} size={24} />
      </div>
      <MessageContent>
        <MessageHeader className="text-xs font-medium text-muted-foreground">
          {name}
          {answeredBy
            ? t(" · answer from {{answeredBy}}", { answeredBy })
            : null}
        </MessageHeader>
        {(message.status === "running" || message.status === "queued") &&
        !message.text ? (
          // Queued, the Bot listens; running, it thinks — the design's faces for each.
          <ChatActivityIndicator
            animation={
              message.status === "queued" ? "face:attentive" : "face:curious"
            }
            avatar={lookOf(message.agentId)}
            label={t("Thinking")}
            phase="thinking"
          />
        ) : message.status === "waiting" ? (
          <p className="text-sm text-muted-foreground">
            {message.reason ?? t("Waiting for your response.")}{" "}
            <Link className="underline" to="/settings/approvals">
              {t("Open approvals")}
            </Link>
          </p>
        ) : message.consent ? (
          // Only the person whose account it asked for can answer; everyone else sees the ask.
          mine ? (
            <TeamBotConsentCard
              botId={message.consent.botId}
              message={message.text}
              serverId={message.consent.serverId}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(
                "Asked a teammate for permission to use their own {{serverId}} account.",
                { serverId: message.consent.serverId },
              )}
            </p>
          )
        ) : message.status === "failed" ? (
          <p className="text-sm text-destructive" role="alert">
            {message.text || t("This Bot could not answer.")}
          </p>
        ) : (
          <BotBubble aria-busy={message.status === "running"}>
            <Streamdown
              translations={streamdownTranslations}
              components={markdownComponents}
            >
              {message.text}
            </Streamdown>
          </BotBubble>
        )}
      </MessageContent>
    </MessageRow>
  );
}

/** Invite another person who has signed in here. They see this whole conversation. */
function AddPerson({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const add = useMutation(addGroupMemberMutationOptions(channelId));
  if (!open)
    return (
      <div className="flex justify-end pb-2">
        <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
          {t("Add a person")}
        </Button>
      </div>
    );
  return (
    <form
      className="flex items-center gap-2 pb-2"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate(email, {
          onSuccess: () => {
            setEmail("");
            setOpen(false);
          },
        });
      }}
    >
      <Input
        aria-label={t("Their email")}
        onChange={(event) => setEmail(event.target.value)}
        placeholder={t("Their email")}
        type="email"
        value={email}
      />
      <Button disabled={!email.trim() || add.isPending} size="sm" type="submit">
        {t("Add")}
      </Button>
      {add.error ? (
        <span className="text-sm text-destructive" role="alert">
          {add.error.message}
        </span>
      ) : null}
    </form>
  );
}

/** Who is in the group. The creator can take people out; anyone else can leave. */
function People({
  channelId,
  me,
  people,
}: {
  channelId: string;
  me: string | undefined;
  people: GroupPerson[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const remove = useMutation(
    removeGroupMemberMutationOptions(queryClient, channelId),
  );
  const iCreated = people.some(
    (person) => person.creator && person.userId === me,
  );
  if (people.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2 text-xs text-muted-foreground">
      <span>{t("People:")}</span>
      {people.map((person) => {
        const self = person.userId === me;
        const removable = self ? !person.creator : iCreated;
        return (
          <span
            className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5"
            key={person.userId}
          >
            {self ? t("You") : (person.name ?? person.email)}
            {removable ? (
              <button
                aria-label={
                  self
                    ? t("Leave this group")
                    : t("Remove {{email}}", { email: person.email })
                }
                className="hover:text-foreground"
                disabled={remove.isPending}
                onClick={() => remove.mutate(person.userId)}
                type="button"
              >
                {self ? t("leave") : "×"}
              </button>
            ) : null}
          </span>
        );
      })}
      {remove.error ? (
        <span className="text-destructive" role="alert">
          {remove.error.message}
        </span>
      ) : null}
    </div>
  );
}
