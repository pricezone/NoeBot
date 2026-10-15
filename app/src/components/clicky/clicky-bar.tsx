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
import { useHoldToTalk } from "@/lib/clicky/hold-to-talk";
import { CLICKY_STOP_ARIA } from "@/lib/clicky/keyboard";
import { clickyCommandMutationOptions } from "@/lib/clicky/mutations";
import {
  CLICKY_NAME,
  CLICKY_NOTICE_KEYS,
  replyText,
} from "@/lib/clicky/notices";
import {
  useClickyCapability,
  useClickyPreferences,
} from "@/lib/clicky/queries";
import {
  clickyLineOf,
  sayClickyLineAgain,
  useClickySpeech,
} from "@/lib/clicky/speech";
import { stopClickyNow, useClickyStopFailed } from "@/lib/clicky/stop";
import {
  selectClickySession,
  useClickyReply,
  useClickySessionView,
} from "@/lib/clicky/use-clicky-session";
import { useInterfaceLocale, useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import {
  CLICKY_PERSON_ONLY_TRIGGERS,
  CLICKY_TEXT_LIMIT,
  type ClickyCommand,
  type ClickyNotice,
  type ClickySession,
} from "../../../../shared/clicky";
import { ClickyOnboarding } from "./clicky-onboarding";
import { ClickyProposalCard } from "./clicky-proposal-card";
import { ClickyStateChip } from "./clicky-state-chip";
import { ClickyTakeoverCard, isBotNeed } from "./clicky-takeover-card";
import { stepOf, useStepLine } from "./clicky-words";

/** How long a refusal ("One moment, I'm still working on the last thing.") stays under the bar. */
const NOTICE_MS = 6_000;

/** The dark viewer's quiet button: white on the backdrop, a tint on hover. */
const QUIET =
  "text-white hover:bg-white/10 hover:text-white dark:hover:bg-white/10 disabled:opacity-40";

/**
 * The bar's one status line, the one part of it drawn again as words arrive: the step being worked
 * on ("Step 2 of 4 — Click Sign in"), or else Clicky's latest words.
 *
 * ONE LINE. The instruction itself is drawn large beside Clicky's pointer, typing in
 * (`ClickyInstruction`); this only says where things are, cut to a line, with the whole of it as the
 * line's title. Something gone wrong (`error`) is said here rather than the step, beside its Retry.
 */
const ClickyStatusLine = memo(function ClickyStatusLine({
  botId,
  stepLine,
}: {
  botId: string;
  /** The walkthrough's step, when there is one and nothing has gone wrong. */
  stepLine: string | null;
}) {
  const { t } = useTranslation();
  const reply = useClickyReply(botId);
  const streaming = reply !== null && reply !== undefined && !reply.final;
  const text =
    stepLine && !streaming
      ? stepLine
      : replyText(reply ?? null, (key, params) => t(key, params));
  return (
    <p
      className="min-w-0 flex-1 truncate pt-1 text-sm leading-snug"
      data-clicky="status"
      title={text || undefined}
    >
      {text}
      {streaming ? (
        <span
          aria-hidden="true"
          className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-white/70 align-middle motion-reduce:animate-none"
        />
      ) : null}
    </p>
  );
});

ClickyStatusLine.displayName = "ClickyStatusLine";

/**
 * Clicky's bar, docked under the Bot's screen in the full-window viewer.
 *
 * One glance says where Clicky is (the chip) and, in one line, which step the person is on or what
 * it last said (streaming in as it arrives); the instruction itself is drawn large beside Clicky's
 * pointer, typing in (`ClickyInstruction`), so the bar does not say it twice. With a walkthrough,
 * Back, Next and Show me again. Below that, a box to ask in words, hold-to-talk where the deployment
 * can listen, Guide or Do it for me, Pause, and a small menu (Say that again, which speaks the line
 * at once and types it in again, whatever the reading-aloud setting; Save notes). Stop is the one
 * red button, always there and always enabled: it is how the person ends anything Clicky is doing,
 * and so is Control-Option-S anywhere.
 *
 * Above the bar, when there is one, and scrolling if they do not all fit so Stop never leaves the
 * screen: Clicky's introduction the first time, the Bot's request for the person when Clicky opened
 * by itself, and a proposal waiting for a yes.
 *
 * Commands go out ONE AT A TIME, in order: a release of the microphone sends "stop listening" and
 * then the question, and the server must see them in that order. STOP IS NOT ONE OF THEM: it goes
 * out at once, whatever is still waiting, and what was waiting is dropped. A refusal comes back as
 * one of Clicky's own lines and shows under the bar for a few seconds.
 *
 * "Do it for me" is not offered at all (rather than offered greyed out) where Clicky may not act:
 * for somebody whose setting is guide only, for a sign-in, a secret or a challenge, which only the
 * person does, and before their settings have arrived.
 *
 * Reads its session from the cache the viewer keeps current. The words of an answer still arriving
 * are not in it: only `ClickyStatusLine` (and the instruction over the screen) read those, and only
 * they are drawn again as they arrive.
 */
export const ClickyBar = memo(function ClickyBar({ botId }: { botId: string }) {
  const session = useClickySessionView(botId, selectClickySession);
  return session ? <ClickyBarBody botId={botId} session={session} /> : null;
});

ClickyBar.displayName = "ClickyBar";

function ClickyBarBody({
  botId,
  session,
}: {
  botId: string;
  session: ClickySession;
}) {
  const { t } = useTranslation();
  const locale = useInterfaceLocale();
  const { voice } = useClickyCapability();
  const preferences = useClickyPreferences();
  const command = useMutation(
    clickyCommandMutationOptions(queryClient, botId),
    queryClient,
  );
  const stopFailed = useClickyStopFailed(botId);
  const [notice, setNotice] = useState<ClickyNotice | null>(null);
  const [question, setQuestion] = useState("");
  const [guidedFor, setGuidedFor] = useState<string | null>(null);

  /** The commands still to go, in order; bumping `generation` drops whatever has not gone yet. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const generation = useRef(0);
  const mutate = command.mutateAsync;
  const send = useCallback(
    (next: ClickyCommand) => {
      setNotice(null);
      const mine = generation.current;
      queue.current = queue.current.then(async () => {
        if (mine !== generation.current) return;
        try {
          const result = await mutate(next);
          if (result.rejected) setNotice(result.rejected);
        } catch {
          // Said under the bar from the mutation's own error; the queue goes on.
        }
      });
    },
    [mutate],
  );
  const stop = useCallback(() => {
    generation.current += 1;
    queue.current = Promise.resolve();
    setNotice(null);
    void stopClickyNow(queryClient, botId);
  }, [botId]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const detailed = preferences.clickyGuidance === "detailed";
  useClickySpeech(botId, preferences.clickySpeakReplies, detailed);
  const translate = (key: string, params?: Record<string, string>) =>
    t(key, params);
  const line = clickyLineOf(session, detailed, translate);
  /*
   * "Say that again": said aloud at once, in this press (a browser speaks only after a gesture, and
   * the setting is for replies arriving, not for a line the person asked to hear), and typed in again
   * beside the pointer. The server is told too, so the phone says it as well.
   */
  const sayAgain = () => {
    sayClickyLineAgain(botId, line, locale);
    send({ type: "repeat" });
  };

  const talk = useHoldToTalk({
    onListen: (active) => send({ type: "listen", active }),
    onAsk: (text) => send({ type: "ask", text }),
  });

  const stepLine = useStepLine(session);
  const step = stepOf(session);
  const busy = command.isPending;
  const stopped = session.state === "stopped";
  const paused = session.state === "paused";
  const trigger = session.trigger;
  // Nothing that depends on the person's setting is offered before it has arrived.
  const policy = preferences.loaded ? preferences.clickyActionPolicy : null;
  const personOnly = trigger
    ? CLICKY_PERSON_ONLY_TRIGGERS.includes(trigger.kind)
    : false;
  const mayAct = policy !== null && policy !== "never" && !personOnly;
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
  const holding = talk.phase === "recording" || talk.phase === "starting";

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

  const cards =
    showTakeover && trigger ? (
      <ClickyTakeoverCard
        actionPolicy={policy}
        busy={busy}
        onCommand={send}
        onGuide={() => setGuidedFor(triggerKey)}
        trigger={trigger}
      />
    ) : null;

  return (
    <section
      aria-label={t(CLICKY_NAME)}
      className="mx-auto flex w-full max-w-3xl flex-col gap-2 text-white"
      data-clicky-bar
      data-clicky-ui
    >
      <div className="flex max-h-[35svh] flex-col gap-2 overflow-y-auto empty:hidden">
        <ClickyOnboarding />
        {cards}
        {session.state === "awaiting_permission" && session.proposal ? (
          <ClickyProposalCard
            actionPolicy={policy}
            busy={busy}
            key={session.proposal.id}
            onCommand={send}
            proposal={session.proposal}
          />
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-2 rounded-2xl bg-white/10 p-2.5 ring-1 ring-white/15 backdrop-blur-md">
        <div className="flex items-start gap-2">
          <ClickyStateChip className="mt-0.5 bg-white/10" session={session} />
          <ClickyStatusLine
            botId={botId}
            stepLine={session.error ? null : stepLine}
          />
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
            onClick={stop}
            size="sm"
            type="button"
          >
            <IconPlayerStopFilled aria-hidden="true" />
            {t("Stop")}
          </Button>
        </div>

        {stopFailed ? (
          <p
            className="flex flex-wrap items-center gap-2 text-[13px] text-red-300"
            role="alert"
          >
            {t("Couldn't stop. Try again.")}
            <Button
              className="h-6 bg-red-600 px-2 text-white hover:bg-red-500"
              onClick={stop}
              size="xs"
              type="button"
            >
              {t("Try again")}
            </Button>
          </p>
        ) : null}

        {step ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
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
            aria-label={t("Ask about the screen")}
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
              aria-label={holding ? t("Release to send") : t("Hold to talk")}
              aria-pressed={holding}
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
              // The system took the pointer away (a scroll, a gesture): nothing was meant.
              onPointerCancel={talk.cancel}
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
              // Losing the capture without a release (a window opening over it) is letting go.
              onLostPointerCapture={() => void talk.release()}
              onPointerUp={() => void talk.release()}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <IconMicrophone aria-hidden="true" />
            </Button>
          ) : null}

          {mayAct ? (
            <fieldset className="m-0 flex min-w-0 items-center gap-0.5 rounded-lg border-0 bg-white/10 p-0.5">
              <legend className="sr-only">{t("How I help")}</legend>
              {modeButton("guide", t("Guide"))}
              {modeButton("act", t("Do it for me"))}
            </fieldset>
          ) : session.mode === "act" ? (
            // Acting where it may not any more (a sign-in arrived): the way back to guiding stays.
            modeButton("guide", t("Guide"))
          ) : null}

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
                  aria-label={t("More options")}
                  className={QUIET}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <IconDots aria-hidden="true" />
            </DropdownMenuTrigger>
            {/*
              Portalled out of the bar, so it carries Clicky's marker itself: the live screen keeps
              the arrows, Enter and Space pressed in here for this page.
            */}
            <DropdownMenuContent align="end" className="w-48" data-clicky-ui>
              <DropdownMenuItem disabled={!line} onClick={sayAgain}>
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
}
