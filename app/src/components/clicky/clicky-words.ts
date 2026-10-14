import {
  CLICKY_STATE_LABEL,
  chipStateOf,
  replyText,
} from "@/lib/clicky/notices";
import { useTranslation } from "@/lib/i18n";
import { type ClickySession, currentStep } from "../../../../shared/clicky";

/**
 * The words Clicky's surfaces share, so the bar, the overlay's announcement and the preview's chip
 * say the same thing in the same language.
 */

/** "Step 2 of 4", and the step's own words, or null when there is no walkthrough under way. */
export function stepOf(session: ClickySession | undefined): {
  number: number;
  total: number;
  title: string;
  detail?: string;
} | null {
  const step = session ? currentStep(session) : null;
  const steps = session?.walkthrough?.steps;
  if (!step || !steps) return null;
  return {
    number: steps.findIndex((candidate) => candidate.id === step.id) + 1,
    total: steps.length,
    title: step.title,
    ...(step.detail ? { detail: step.detail } : {}),
  };
}

/** What the state chip says now. */
export function useClickyStateLabel(
  session: ClickySession | undefined,
): string {
  const { t } = useTranslation();
  return t(CLICKY_STATE_LABEL[chipStateOf(session)]);
}

/** Clicky's latest line, translated where it is one of Clicky's own. */
export function useClickyReply(session: ClickySession | undefined): string {
  const { t } = useTranslation();
  return replyText(session?.reply ?? null, (key) => t(key));
}

/** "Step 2 of 4 — Click Sign in", or null. */
export function useStepLine(session: ClickySession | undefined): string | null {
  const { t } = useTranslation();
  const step = stepOf(session);
  if (!step) return null;
  return t("Step {{number}} of {{total}} — {{title}}", {
    number: step.number,
    total: step.total,
    title: step.title,
  });
}

/**
 * What a screen reader hears from the overlay: the step being worked on, or, without one, Clicky's
 * latest line once it has finished arriving (never each word as it streams).
 */
export function useClickyAnnouncement(session: ClickySession): string {
  const step = useStepLine(session);
  const reply = useClickyReply(session);
  if (!session.awake) return "";
  if (step) return step;
  return session.reply?.final ? reply : "";
}
