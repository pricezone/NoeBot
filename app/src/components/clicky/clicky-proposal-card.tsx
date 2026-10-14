import { IconAlertTriangle } from "@tabler/icons-react";
import { memo, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { formatElapsed } from "@/lib/i18n/strings";
import type {
  ClickyAction,
  ClickyCommand,
  ClickyProposal,
} from "../../../../shared/clicky";
import type { ClickyActionPolicy } from "../../../../shared/user-preferences";

/** Seconds left until `expiresAt`, ticking once a second; never below zero. */
function useSecondsLeft(expiresAt: string): number {
  const deadline = Date.parse(expiresAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(deadline)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
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
      return t("Type “{{text}}” into: {{target}}", {
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
 * Clicky asking before it does something on the computer.
 *
 * What it wants to do and why, a warning when the guardrails rated it hard to undo, and the three
 * answers: Allow once, Allow for this task (only for a low-risk action, and only for somebody whose
 * setting lets one yes cover a task), and Not now. The request lapses after two minutes, counted
 * down here; the server is what expires it.
 */
export const ClickyProposalCard = memo(function ClickyProposalCard({
  proposal,
  actionPolicy,
  busy,
  onCommand,
}: {
  proposal: ClickyProposal;
  actionPolicy: ClickyActionPolicy;
  busy: boolean;
  onCommand: (command: ClickyCommand) => void;
}) {
  const { t } = useTranslation();
  const left = useSecondsLeft(proposal.expiresAt);
  const expired = left <= 0;
  const words = useActionWords(proposal.action);
  const taskWide =
    proposal.risk === "low" && actionPolicy === "ask_once_per_task";
  return (
    <section
      aria-label={t("Clicky asks before doing this")}
      className="flex flex-col gap-2 rounded-xl bg-white p-3 text-zinc-900 shadow-lg"
      data-clicky-card="proposal"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-zinc-500">{t("Clicky would like to")}</p>
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
      {proposal.risk === "confirm" && proposal.riskReason ? (
        <p className="text-xs text-zinc-600">{proposal.riskReason}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy || expired}
          onClick={() =>
            onCommand({
              type: "approve",
              proposalId: proposal.id,
              scope: "once",
            })
          }
          size="sm"
        >
          {t("Allow once")}
        </Button>
        {taskWide ? (
          <Button
            className="border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100"
            disabled={busy || expired}
            onClick={() =>
              onCommand({
                type: "approve",
                proposalId: proposal.id,
                scope: "task",
              })
            }
            size="sm"
            variant="outline"
          >
            {t("Allow for this task")}
          </Button>
        ) : null}
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
