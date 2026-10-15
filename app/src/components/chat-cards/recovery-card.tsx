import {
  IconAlertCircle,
  IconInfoCircle,
  IconLoader2,
  IconPlayerPause,
  IconX,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useComputerControl } from "@/lib/computers/use-control";
import { useConversation } from "@/lib/copilot/conversation";
import { type UiStrings, useUiStrings } from "@/lib/i18n/strings";
import { cn } from "@/lib/utils";

/**
 * Every "that did not work, here is what you can do" in a conversation, drawn one way.
 *
 * ONE CARD, FOR THE REASON QUESTIONCARD IS ONE CARD. A turn that stopped, a message that was not
 * sent, a browser task paused on a handoff, a step that failed in the browser, a card that could not
 * be drawn, history that would not load: each used to be its own red or amber line, most of them
 * with no way forward but "refresh". The person meets one kind of moment — something went wrong and
 * the Bot is waiting on them — so it looks the same every time: the card's shell from QuestionCard,
 * an icon, the reason in plain words, and the ways forward as pills.
 *
 * THE ACTIONS ARE A FIXED VOCABULARY, each optional: Retry, Resume, Continue, Take over, Ask again,
 * Open screen, Stop waiting, Discard, and the X to dismiss. A caller hands over the handlers it can
 * honour and nothing else; a pill is never drawn that would do nothing. The first one given is the
 * primary pill, in the order below, so the likeliest way forward is the prominent one.
 */

export type RecoveryAction =
  | "resume"
  | "retry"
  | "tryAgain"
  | "continue"
  | "takeOver"
  | "askAgain"
  | "openScreen"
  | "stopWaiting"
  | "discard";

/** The order pills are drawn in, which is also which one is primary. */
const ORDER: readonly RecoveryAction[] = [
  "resume",
  "retry",
  "tryAgain",
  "continue",
  "takeOver",
  "askAgain",
  "openScreen",
  "stopWaiting",
  "discard",
];

const LABEL: Record<RecoveryAction, (ui: UiStrings) => string> = {
  resume: (ui) => ui.resume,
  retry: (ui) => ui.retry,
  tryAgain: (ui) => ui.tryAgain,
  continue: (ui) => ui.continue,
  takeOver: (ui) => ui.takeOver,
  askAgain: (ui) => ui.askAgain,
  openScreen: (ui) => ui.openScreen,
  stopWaiting: (ui) => ui.stopWaiting,
  discard: (ui) => ui.discard,
};

export type RecoveryTone = "error" | "paused" | "info";

export function RecoveryCard({
  title,
  detail,
  tone = "error",
  compact = false,
  onRetry,
  onTryAgain,
  onResume,
  onContinue,
  onTakeOver,
  onAskAgain,
  onOpenScreen,
  onStopWaiting,
  onDiscard,
  onDismiss,
  busy,
  disabled = false,
  testId,
  className,
}: {
  /** What happened, in a sentence the person can act on. */
  title: ReactNode;
  /** The muted line under it: why, or what the way forward does. */
  detail?: ReactNode;
  /** An error is announced as an alert; a pause or a notice as a status. */
  tone?: RecoveryTone;
  /** Tighter, for a card that sits inside a step (a browser group) or above the composer. */
  compact?: boolean;
  onRetry?: () => void;
  /** Retry's wording for asking the Bot to have another go, rather than redoing a step here. */
  onTryAgain?: () => void;
  onResume?: () => void;
  onContinue?: () => void;
  onTakeOver?: () => void;
  onAskAgain?: () => void;
  onOpenScreen?: () => void;
  onStopWaiting?: () => void;
  onDiscard?: () => void;
  /** The X at the top right: the card goes, nothing else happens. */
  onDismiss?: () => void;
  /** The action on its way: its pill spins and the others wait. */
  busy?: RecoveryAction;
  /** Every pill drawn but none pressable, for a moment nothing can be done yet (a run going). */
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  const ui = useUiStrings();
  const titleId = useId();
  const handlers: Record<RecoveryAction, (() => void) | undefined> = {
    resume: onResume,
    retry: onRetry,
    tryAgain: onTryAgain,
    continue: onContinue,
    takeOver: onTakeOver,
    askAgain: onAskAgain,
    openScreen: onOpenScreen,
    stopWaiting: onStopWaiting,
    discard: onDiscard,
  };
  const Icon =
    tone === "error"
      ? IconAlertCircle
      : tone === "paused"
        ? IconPlayerPause
        : IconInfoCircle;

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "w-full max-w-2xl rounded-2xl bg-muted dark:bg-card",
        compact ? "my-1 p-3" : "my-2 p-4",
        className,
      )}
      data-slot="recovery-card"
      data-testid={testId}
      data-tone={tone}
      role={tone === "error" ? "alert" : "status"}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "flex shrink-0 items-center justify-center rounded-lg bg-background/70 dark:bg-muted",
              compact ? "size-7" : "size-8",
              tone === "error"
                ? "text-amber-600 dark:text-amber-500"
                : "text-muted-foreground",
            )}
          >
            <Icon className={compact ? "size-4" : "size-[18px]"} />
          </span>
          <div className="min-w-0 pt-0.5">
            <p
              className={cn(
                "break-words font-semibold leading-snug",
                compact ? "text-sm" : "text-[15px]",
              )}
              id={titleId}
            >
              {title}
            </p>
            {detail ? (
              <p className="mt-0.5 break-words text-muted-foreground text-sm leading-snug">
                {detail}
              </p>
            ) : null}
          </div>
        </div>
        {onDismiss ? (
          <button
            aria-label={ui.dismiss}
            className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={onDismiss}
            type="button"
          >
            <IconX className="size-4" />
          </button>
        ) : null}
      </header>
      <RecoveryActions
        busy={busy}
        className={compact ? "mt-2 pl-10" : "mt-3 pl-11"}
        compact={compact}
        disabled={disabled}
        handlers={handlers}
      />
    </section>
  );
}

/** The pills, in the fixed order, the first one primary. Nothing when no handler was given. */
function RecoveryActions({
  handlers,
  busy,
  disabled,
  compact,
  className,
}: {
  handlers: Partial<Record<RecoveryAction, (() => void) | undefined>>;
  busy?: RecoveryAction | undefined;
  disabled: boolean;
  compact: boolean;
  className?: string;
}) {
  const ui = useUiStrings();
  const actions = ORDER.filter((action) => handlers[action] !== undefined);
  if (actions.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {actions.map((action, index) => {
        const working = busy === action;
        return (
          <Button
            aria-busy={working || undefined}
            className={cn(
              "rounded-full",
              compact ? "h-8 px-3 text-sm" : "h-9 px-4 text-[15px]",
            )}
            data-action={action}
            disabled={disabled || busy !== undefined}
            key={action}
            onClick={handlers[action]}
            type="button"
            variant={index === 0 ? "default" : "outline"}
          >
            {working ? <IconLoader2 className="animate-spin" /> : null}
            {LABEL[action](ui)}
          </Button>
        );
      })}
    </div>
  );
}

/**
 * The same reason and pills without the card around them, for a card that already has a shell of
 * its own: the line under a Secure Form row that says how the request ended and offers Ask again.
 */
export function RecoveryLine({
  reason,
  onAskAgain,
  onRetry,
  onTryAgain,
  onOpenScreen,
  busy,
}: {
  reason?: ReactNode;
  onAskAgain?: () => void;
  onRetry?: () => void;
  /** Retry's wording for asking the Bot to have another go, rather than redoing a step here. */
  onTryAgain?: () => void;
  onOpenScreen?: () => void;
  busy?: RecoveryAction;
}) {
  return (
    <div className="flex flex-col gap-2" data-slot="recovery-line">
      {reason ? <p className="break-words">{reason}</p> : null}
      <RecoveryActions
        busy={busy}
        compact
        disabled={false}
        handlers={{
          askAgain: onAskAgain,
          retry: onRetry,
          tryAgain: onTryAgain,
          openScreen: onOpenScreen,
        }}
      />
    </div>
  );
}

/**
 * A notice about the conversation itself, above the composer: history that would not load, voice
 * chats that could not be read. It used to be a sentence ending "Refresh to try again" with nothing
 * to press; now Retry reads it again, through the callback the screen that loads it hands over.
 */
export function ChatNotice({
  kind,
  message,
  onRetry,
}: {
  /** A notice whose words are this table's own. */
  kind?: "voice-chats";
  /** A notice in the words the caller wrote, shown in this language where it is one we know. */
  message?: string;
  onRetry?: () => void;
}) {
  const ui = useUiStrings();
  const title =
    kind === "voice-chats"
      ? ui.voiceChatsUnavailable
      : ui.reason(message ?? "");
  return (
    <RecoveryCard
      className="mb-2"
      compact
      title={title}
      tone={onRetry ? "error" : "info"}
      {...(onRetry ? { onRetry } : {})}
    />
  );
}

/**
 * The Bot's screen, opened from a card: the bot panel on the Computer tab with the full-window
 * viewer up, in the conversation the person is reading.
 *
 * WHERE THE PERSON IS, NOT /bot. A card used to send them to the Bot's own page, which is a
 * different conversation; the channel route opens the same panel from `?panel=computer&record=true`
 * (the Skills tab's "Record skill" lands that way), and the viewer it opens is where the wheel is.
 * Read off the address at the press rather than from router state, so a card drawn outside a route
 * (a test, a gallery preview) still renders.
 *
 * Take over asks for the wheel first, through the same shared store the viewer's own button uses,
 * and opens the screen either way: a refused take leaves the viewer saying why, beside its own Take
 * control. A card that only opens the screen passes `withTakeOver: false` and joins no control poll.
 */
export function useBotScreen(
  botId: string,
  withTakeOver = true,
): {
  openScreen: () => void;
  takeOver: () => Promise<void>;
  taking: boolean;
} {
  const navigate = useNavigate();
  const { change } = useComputerControl(botId, withTakeOver);
  const [taking, setTaking] = useState(false);
  const openScreen = useCallback(() => {
    const channel = /^\/channel\/([^/]+)\/?$/.exec(
      window.location.pathname,
    )?.[1];
    if (channel && channel !== "new") {
      void navigate({
        to: "/channel/$channelId",
        params: { channelId: decodeURIComponent(channel) },
        search: { panel: "computer", record: true },
      });
      return;
    }
    void navigate({
      to: "/bot",
      search: { agent: botId, panel: "computer", record: true },
    });
  }, [navigate, botId]);
  const takeOver = useCallback(async () => {
    setTaking(true);
    try {
      await change?.("take", { source: "manual" });
    } finally {
      setTaking(false);
      openScreen();
    }
  }, [change, openScreen]);
  return { openScreen, takeOver, taking };
}

/**
 * Whether the conversation says the Bot's last turn ended mid-task: a tool result and then nothing,
 * no words after it. Read defensively, because the flag is the conversation's to compute and an
 * older provider does not carry it.
 */
export function unfinishedTurnOf(conversation: unknown): boolean {
  return (
    typeof conversation === "object" &&
    conversation !== null &&
    "unfinishedTurn" in conversation &&
    conversation.unfinishedTurn === true
  );
}

/** "The Bot stopped before finishing" with a Continue that says so, as the person. */
export function UnfinishedTurnCard({
  onContinue,
  busy = false,
}: {
  onContinue: () => void;
  busy?: boolean;
}) {
  const ui = useUiStrings();
  return (
    <RecoveryCard
      onContinue={onContinue}
      testId="transcript-unfinished"
      title={ui.unfinishedTurn}
      tone="paused"
      {...(busy ? { busy: "continue" as const } : {})}
    />
  );
}

/**
 * The card above, wired to the conversation: shown while the conversation says the turn is
 * unfinished and no other turn is going, and gone the moment Continue has gone out. A Continue that
 * could not be sent comes back, so the person can press it again.
 */
export function UnfinishedTurn() {
  const conversation = useConversation();
  const ui = useUiStrings();
  const unfinished = unfinishedTurnOf(conversation);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!unfinished) setSending(false);
  }, [unfinished]);
  if (!conversation || !unfinished || conversation.turnActive === true)
    return null;
  return (
    <UnfinishedTurnCard
      busy={sending}
      onContinue={() => {
        setSending(true);
        void Promise.resolve(conversation.ask(ui.continueMessage)).then(
          (sent) => {
            if (sent === false) setSending(false);
          },
          () => setSending(false),
        );
      }}
    />
  );
}
