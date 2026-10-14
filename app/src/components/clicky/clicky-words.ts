import { CLICKY_STATE_LABEL, chipStateOf } from "@/lib/clicky/notices";
import { useTranslation } from "@/lib/i18n";
import { type ClickySession, currentStep } from "../../../../shared/clicky";

/**
 * The words Clicky's surfaces share, so the bar and the preview's chip say the same thing in the
 * same language.
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
  session: Pick<ClickySession, "awake" | "state"> | undefined,
): string {
  const { t } = useTranslation();
  return t(CLICKY_STATE_LABEL[chipStateOf(session)]);
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
