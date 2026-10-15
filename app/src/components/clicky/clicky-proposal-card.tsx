import { IconAlertTriangle } from "@tabler/icons-react";
import { memo, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  loadServerMessages,
  localizeServerMessage,
} from "@/lib/i18n/server-messages";
import { formatElapsed } from "@/lib/i18n/strings";
import type {
  ClickyAction,
  ClickyCommand,
  ClickyProposal,
} from "../../../../shared/clicky";
import type { ClickyActionPolicy } from "../../../../shared/user-preferences";

/**
 * How long the Allow buttons stay asleep after a proposal appears, as a browser's permission prompt
 * does: a click aimed at whatever was under the pointer a moment ago must not become a yes.
 */
export const CLICKY_ALLOW_ARM_MS = 700;

/**
 * Seconds left, ticking once a second; never below zero.
 *
 * Counted from when THIS tab first saw the proposal, for as long as the server gave it
 * (`expiresAt - createdAt`), rather than by comparing this computer's clock with the server's: a
 * clock a minute out would otherwise show a fresh request as already lapsed, or a lapsed one as open.
 * The server is what expires it; this only says roughly how long is left.
 */
function useSecondsLeft(proposal: ClickyProposal): number {
  const [deadline] = useState(() => {
    const lifetime =
      Date.parse(proposal.expiresAt) - Date.parse(proposal.createdAt);
    return Number.isFinite(lifetime) ? Date.now() + Math.max(0, lifetime) : 0;
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Whether `ms` have passed since this was first drawn. */
function useArmed(ms: number): boolean {
  const [armed, setArmed] = useState(ms <= 0);
  useEffect(() => {
    if (ms <= 0) return;
    const timer = window.setTimeout(() => setArmed(true), ms);
    return () => window.clearTimeout(timer);
  }, [ms]);
  return armed;
}

/**
 * A sentence the server wrote (the guardrails' reason), in the interface's language where the
 * server's catalog has it, and as the server sent it otherwise.
 */
function useServerSentence(english: string | undefined): string {
  const [, setLoaded] = useState(0);
  useEffect(() => {
    if (!english) return;
    let current = true;
    void loadServerMessages().then(() => {
      if (current) setLoaded((n) => n + 1);
    });
    return () => {
      current = false;
    };
  }, [english]);
  return english ? localizeServerMessage(english) : "";
}

/** What the action is, as a short instruction: "Click: the Search box". */
function useActionWords(action: ClickyAction): string {
  const { t } = useTranslation();
  switch (action.kind) {
    case "click":
      if (action.double)
        return t("Double-click: {{target}}", { target: action.label });
      if (action.button === "right")
        return t("Right-click: {{target}}", { target: action.label });
      return t("Click: {{target}}", { target: action.label });
    case "type":
      // Enter is part of the yes: a search runs, a form may be sent. Said, never left implied.
      return action.pressEnter
        ? t("Type “{{text}}” into: {{target}}, then press Enter", {
            text: action.text,
            target: action.label,
          })
        : t("Type “{{text}}” into: {{target}}", {
            text: action.text,
            target: action.label,
          });
    case "key":
      return t("Press: {{target}}", { target: action.label || action.keys });
    case "scroll":
      return t("Scroll: {{target}}", { target: action.label });
  }
}

/**
 * "Show me how" (Clicky) asking before it does something on the computer.
 *
 * What it wants to do and why, a warning when the guardrails rated it hard to undo, and two answers:
 *
 * - an everyday (low-risk) action, for somebody whose setting asks once per session: "Allow for this
 *   session", one yes that covers every everyday action until Clicky sleeps, is stopped or two hours
 *   pass (`ClickyTaskGrant`), and Not now;
 * - the same for somebody who asked to be asked every time (or before their setting has arrived):
 *   "Allow once", and Not now;
 * - something hard to undo (a submit, a send, closing a window): "Allow", once, beside "Can't be
 *   undone", and Not now. It is asked about every time, whatever was allowed before.
 *
 * The request lapses after two minutes, counted down here; the server is what expires it.
 *
 * Drawn with `key={proposal.id}`, so a new proposal is a new card: its Allow buttons wait a moment
 * again, and its countdown starts again.
 */
export const ClickyProposalCard = memo(function ClickyProposalCard({
  proposal,
  actionPolicy,
  busy,
  onCommand,
  armDelayMs = CLICKY_ALLOW_ARM_MS,
}: {
  proposal: ClickyProposal;
  /** The person's setting; null until it has loaded, when nothing that depends on it is offered. */
  actionPolicy: ClickyActionPolicy | null;
  busy: boolean;
  onCommand: (command: ClickyCommand) => void;
  armDelayMs?: number;
}) {
  const { t } = useTranslation();
  const left = useSecondsLeft(proposal);
  const expired = left <= 0;
  const armed = useArmed(armDelayMs);
  const words = useActionWords(proposal.action);
  const riskReason = useServerSentence(proposal.riskReason);
  // The person's setting, read as the server reads it: the old "once per task" is once per session.
  const sessionWide =
    proposal.risk === "low" &&
    (actionPolicy === "ask_once_per_session" ||
      actionPolicy === "ask_once_per_task");
  const allow = (scope: "once" | "session") =>
    onCommand({ type: "approve", proposalId: proposal.id, scope });
  return (
    <section
      aria-label={t("May I do this?")}
      className="flex flex-col gap-2 rounded-xl bg-white p-3 text-zinc-900 shadow-lg"
      data-clicky-card="proposal"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-zinc-500">{t("I'd like to")}</p>
          <p className="font-medium text-[15px] leading-snug">{words}</p>
          {proposal.why ? (
            <p className="mt-0.5 text-sm text-zinc-600">{proposal.why}</p>
          ) : null}
        </div>
        {proposal.risk === "confirm" ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900 text-xs">
            <IconAlertTriangle aria-hidden="true" className="size-3.5" />
            {t("Can't be undone")}
          </span>
        ) : null}
      </div>
      {proposal.risk === "confirm" && riskReason ? (
        <p className="text-xs text-zinc-600">{riskReason}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy || expired || !armed}
          onClick={() => allow(sessionWide ? "session" : "once")}
          size="sm"
        >
          {sessionWide
            ? t("Allow for this session")
            : proposal.risk === "confirm"
              ? t("Allow")
              : t("Allow once")}
        </Button>
        <Button
          className="text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900"
          disabled={busy}
          onClick={() => onCommand({ type: "deny", proposalId: proposal.id })}
          size="sm"
          variant="ghost"
        >
          {t("Not now")}
        </Button>
        <span className="ml-auto text-xs text-zinc-500 tabular-nums">
          {expired
            ? t("Timed out")
            : t("{{value}} left", { value: formatElapsed(left) })}
        </span>
      </div>
    </section>
  );
});

ClickyProposalCard.displayName = "ClickyProposalCard";
