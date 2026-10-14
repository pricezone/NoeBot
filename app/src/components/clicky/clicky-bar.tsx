import {
  IconArrowLeft,
  IconArrowRight,
  IconDots,
  IconMicrophone,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconPointer,
  IconRefresh,
  IconSend2,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHoldToTalk } from "@/lib/clicky/hold-to-talk";
import { CLICKY_STOP_ARIA } from "@/lib/clicky/keyboard";
import { clickyCommandMutationOptions } from "@/lib/clicky/mutations";
import { CLICKY_NAME, CLICKY_NOTICE_KEYS } from "@/lib/clicky/notices";
import {
  useClickyCapability,
  useClickyPreferences,
} from "@/lib/clicky/queries";
import { useClickySpeech } from "@/lib/clicky/speech";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import {
  CLICKY_TEXT_LIMIT,
  type ClickyCommand,
  type ClickyNotice,
  type ClickySession,
} from "../../../../shared/clicky";
import { ClickyOnboarding } from "./clicky-onboarding";
import { ClickyProposalCard } from "./clicky-proposal-card";
import { ClickyStateChip } from "./clicky-state-chip";
import { ClickyTakeoverCard, isBotNeed } from "./clicky-takeover-card";
import { stepOf, useClickyReply, useStepLine } from "./clicky-words";

/** How long a refusal ("One moment, I'm still working on the last thing.") stays under the bar. */
const NOTICE_MS = 6_000;

/** The dark viewer's quiet button: white on the backdrop, a tint on hover. */
const QUIET =
  "text-white hover:bg-white/10 hover:text-white dark:hover:bg-white/10 disabled:opacity-40";

/**
 * Clicky's bar, docked under the Bot's screen in the full-window viewer.
 *
 * One glance says where Clicky is (the chip), what it last said (streaming in as it arrives), and
 * which step of a walkthrough the person is on, with Back, Next and Show me again. Below that, a box
 * to ask in words, hold-to-talk where the deployment can listen, Guide or Do it for me, Pause, and a
 * small menu (Save notes, Say that again). Stop is the one red button, always there and always
 * enabled: it is how the person ends anything Clicky is doing, and so is Control-Option-S anywhere.
 *
 * Above the bar, when there is one: Clicky's introduction the first time, the Bot's request for the
 * person when Clicky opened by itself, and a proposal waiting for a yes.
 *
 * Commands go out ONE AT A TIME, in order: a release of the microphone sends "stop listening" and
 * then the question, and the server must see them in that order. A refusal comes back as one of
 * Clicky's own lines and shows under the bar for a few seconds.
 */
export const ClickyBar = memo(function ClickyBar({
  botId,
  session,
}: {
  botId: string;
  session: ClickySession;
}) {
  const { t } = useTranslation();
  const { voice } = useClickyCapability();
  const preferences = useClickyPreferences();
  const command = useMutation(
    clickyCommandMutationOptions(queryClient, botId),
    queryClient,
  );
  const [notice, setNotice] = useState<ClickyNotice | null>(null);
  const [question, setQuestion] = useState("");
  const [guidedFor, setGuidedFor] = useState<string | null>(null);

  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const mutate = command.mutateAsync;
  const send = useCallback(
    (next: ClickyCommand) => {
      setNotice(null);
      queue.current = queue.current
        .then(() => mutate(next))
        .then((result) => {
          if (result.rejected) setNotice(result.rejected);
        })
        .catch(() => {
          // Said under the bar from the mutation's own error; the queue goes on.
        });
    },
    [mutate],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useClickySpeech(session, preferences.clickySpeakReplies);

  const talk = useHoldToTalk({
    onListen: (active) => send({ type: "listen", active }),
    onAsk: (text) => send({ type: "ask", text }),
  });

  const reply = useClickyReply(session);
  const stepLine = useStepLine(session);
  const step = stepOf(session);
  const streaming = session.reply !== null && !session.reply.final;
  const busy = command.isPending;
  const stopped = session.state === "stopped";
  const paused = session.state === "paused";
  const guideOnly = preferences.clickyActionPolicy === "never";
  const trigger = session.trigger;
  const triggerKey = trigger
    ? `${trigger.kind}:${trigger.requestId ?? trigger.reason ?? ""}`
    : null;
  const showTakeover =
    isBotNeed(trigger) &&
    trigger !== null &&
    session.mode === "guide" &&
    session.state !== "awaiting_permission" &&
    session.state !== "acting" &&
    !stopped &&
    guidedFor !== triggerKey;

  const ask = () => {
    const text = question.trim().slice(0, CLICKY_TEXT_LIMIT);
    if (!text) return;
    send({ type: "ask", text });
    setQuestion("");
  };

  const modeButton = (mode: "guide" | "act", label: string) => (
    <Button
      aria-pressed={session.mode === mode}
      className={cn(
        "h-7 rounded-md px-2.5 text-[13px]",
        session.mode === mode
          ? "bg-white text-zinc-900 hover:bg-white"
          : "bg-transparent text-white hover:bg-white/10",
      )}
      disabled={mode === "act" && guideOnly}
      onClick={() => {
        if (session.mode !== mode) send({ type: "set_mode", mode });
      }}
      size="sm"
      type="button"
      variant="ghost"
    >
      {label}
    </Button>
  );

  return (
    <section
      aria-label={CLICKY_NAME}
      className="mx-auto flex w-full max-w-3xl flex-col gap-2 text-white"
      data-clicky-bar
    >
      <ClickyOnboarding />
      {showTakeover && trigger ? (
        <ClickyTakeoverCard
          actionPolicy={preferences.clickyActionPolicy}
          busy={busy}
          onCommand={send}
          onGuide={() => setGuidedFor(triggerKey)}
          trigger={trigger}
        />
      ) : null}
      {session.state === "awaiting_permission" && session.proposal ? (
        <ClickyProposalCard
          actionPolicy={preferences.clickyActionPolicy}
          busy={busy}
          onCommand={send}
          proposal={session.proposal}
        />
      ) : null}

      <div className="flex flex-col gap-2 rounded-2xl bg-white/10 p-2.5 ring-1 ring-white/15 backdrop-blur-md">
        <div className="flex items-start gap-2">
          <ClickyStateChip className="mt-0.5 bg-white/10" session={session} />
          <p
            className="line-clamp-2 min-w-0 flex-1 pt-0.5 text-sm leading-snug"
            data-clicky="reply"
          >
            {reply}
            {streaming ? (
              <span
                aria-hidden="true"
                className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-white/70 align-middle motion-reduce:animate-none"
              />
            ) : null}
          </p>
          {session.error ? (
            <Button
              className={QUIET}
              disabled={busy}
              onClick={() => send({ type: "retry" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              <IconRefresh aria-hidden="true" />
              {t("Retry")}
            </Button>
          ) : null}
          <Button
            aria-keyshortcuts={CLICKY_STOP_ARIA}
            className="bg-red-600 text-white hover:bg-red-500"
            onClick={() => send({ type: "stop" })}
            size="sm"
            type="button"
          >
            <IconPlayerStopFilled aria-hidden="true" />
            {t("Stop")}
          </Button>
        </div>

        {step && stepLine ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="min-w-0 flex-1 truncate font-medium text-sm">
              {stepLine}
            </p>
            <Button
              className={QUIET}
              disabled={step.number <= 1}
              onClick={() => send({ type: "back" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              <IconArrowLeft aria-hidden="true" />
              {t("Back")}
            </Button>
            <Button
              className={QUIET}
              onClick={() => send({ type: "next" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("Next")}
              <IconArrowRight aria-hidden="true" />
            </Button>
            <Button
              className={QUIET}
              onClick={() => send({ type: "show_me" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              <IconPointer aria-hidden="true" />
              {t("Show me again")}
            </Button>
          </div>
        ) : null}

        {notice ? (
          <p className="text-[13px] text-white/80" role="status">
            {t(CLICKY_NOTICE_KEYS[notice])}
          </p>
        ) : null}
        {command.error ? (
          <p className="text-[13px] text-red-300" role="alert">
            {command.error.message}
          </p>
        ) : null}
        {talk.error ? (
          <p className="text-[13px] text-red-300" role="alert">
            {talk.error}
          </p>
        ) : null}

        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            ask();
          }}
        >
          <input
            aria-label={t("Ask Clicky")}
            className="h-8 min-w-40 flex-1 rounded-lg bg-white/10 px-3 text-sm text-white outline-none ring-1 ring-white/15 placeholder:text-white/50 focus-visible:ring-2 focus-visible:ring-white/60"
            maxLength={CLICKY_TEXT_LIMIT}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t("Ask about the screen…")}
            value={question}
          />
          <Button
            aria-label={t("Ask")}
            className={QUIET}
            disabled={!question.trim()}
            size="icon-sm"
            type="submit"
            variant="ghost"
          >
            <IconSend2 aria-hidden="true" />
          </Button>
          {voice ? (
            <Button
              aria-label={
                talk.phase === "recording" || talk.phase === "starting"
                  ? t("Release to send")
                  : t("Hold to talk")
              }
              aria-pressed={
                talk.phase === "recording" || talk.phase === "starting"
              }
              className={cn(
                QUIET,
                "touch-none select-none",
                talk.phase === "recording" &&
                  "bg-sky-500 text-white hover:bg-sky-500",
              )}
              data-clicky="hold-to-talk"
              disabled={talk.phase === "sending"}
              onContextMenu={(event) => event.preventDefault()}
              onKeyDown={(event) => {
                if (
                  (event.key === " " || event.key === "Enter") &&
                  !event.repeat
                ) {
                  event.preventDefault();
                  void talk.press();
                }
              }}
              onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  void talk.release();
                }
              }}
              onPointerCancel={() => void talk.release()}
              onPointerDown={(event) => {
                event.preventDefault();
                // Held even when the finger or the pointer drifts off the button.
                try {
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                } catch {
                  // A pointer the browser no longer tracks: the release still arrives here.
                }
                void talk.press();
              }}
              onPointerUp={() => void talk.release()}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <IconMicrophone aria-hidden="true" />
            </Button>
          ) : null}

          <fieldset className="m-0 flex min-w-0 items-center gap-0.5 rounded-lg border-0 bg-white/10 p-0.5">
            <legend className="sr-only">{t("How Clicky helps")}</legend>
            {modeButton("guide", t("Guide"))}
            {guideOnly ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" />}>
                  {modeButton("act", t("Do it for me"))}
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t(CLICKY_NOTICE_KEYS.guide_only)}
                </TooltipContent>
              </Tooltip>
            ) : (
              modeButton("act", t("Do it for me"))
            )}
          </fieldset>

          {paused || stopped ? (
            <Button
              className={QUIET}
              onClick={() => send({ type: "resume" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              <IconPlayerPlayFilled aria-hidden="true" />
              {t("Resume")}
            </Button>
          ) : (
            <Button
              className={QUIET}
              onClick={() => send({ type: "pause" })}
              size="sm"
              type="button"
              variant="ghost"
            >
              <IconPlayerPauseFilled aria-hidden="true" />
              {t("Pause")}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={t("More for Clicky")}
                  className={QUIET}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <IconDots aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                disabled={!session.reply}
                onClick={() => send({ type: "repeat" })}
              >
                {t("Say that again")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => send({ type: "save_notes" })}>
                {t("Save notes")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </form>
      </div>
    </section>
  );
});

ClickyBar.displayName = "ClickyBar";
