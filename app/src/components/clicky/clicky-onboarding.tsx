import { useMutation, useQuery } from "@tanstack/react-query";
import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { clickyStopKeys } from "@/lib/clicky/keyboard";
import { CLICKY_NAME } from "@/lib/clicky/notices";
import { useClickyPreferences } from "@/lib/clicky/queries";
import { msg, useTranslation } from "@/lib/i18n";
import { saveUserPreferencesMutationOptions } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";

const CARDS = [
  {
    heading: CLICKY_NAME,
    body: msg(
      "I point at the part of the screen that matters and walk you through it, one step at a time. Ask me anything, by typing or by holding the microphone.",
    ),
  },
  {
    heading: msg("Guide, or Do it for me"),
    body: msg(
      "I guide you by default. Turn on Do it for me and I can click and type for you. I ask you first, once for the session, and again for anything that can't be undone.",
    ),
  },
  {
    heading: msg("Stop anytime"),
    body: msg(
      "Press Stop, or these keys, whenever you like, even from your phone. Nothing else happens until you say so.",
    ),
  },
] as const;

/** Whether this person has yet to see Clicky's introduction. False until their settings arrive. */
export function useClickyOnboardingDue(): boolean {
  const preferences = useClickyPreferences();
  return preferences.loaded && !preferences.clickyOnboarded;
}

/**
 * Clicky's introduction, the first time it opens: three short cards, then never again.
 *
 * Drawn in Clicky's bar rather than as a dialog over the screen, because Clicky can open by itself
 * when the Bot needs the person, and a modal in front of the very screen it needs them on would be
 * in the way. Finishing or skipping saves `clickyOnboarded`, which follows the person to every
 * device; until the save lands, this tab already treats it as seen.
 */
export const ClickyOnboarding = memo(function ClickyOnboarding() {
  const { t } = useTranslation();
  const { data: user } = useQuery(currentUserQueryOptions(), queryClient);
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, user?.id),
    queryClient,
  );
  const [page, setPage] = useState(0);
  const [finished, setFinished] = useState(false);
  const due = useClickyOnboardingDue();
  if (!due || finished) return null;
  const card = CARDS[page] ?? CARDS[0];
  const last = page === CARDS.length - 1;
  const finish = () => {
    setFinished(true);
    save.mutate({ clickyOnboarded: true });
  };
  return (
    <section
      aria-label={t("About Show me how")}
      className="flex flex-col gap-2 rounded-xl bg-white p-3 text-zinc-900 shadow-lg"
      data-clicky-card="onboarding"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold text-[15px]">{t(card.heading)}</h3>
        <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
          {t("{{number}} of {{total}}", {
            number: page + 1,
            total: CARDS.length,
          })}
        </span>
      </div>
      <p className="text-sm text-zinc-700">{t(card.body)}</p>
      {last ? (
        <p className="flex gap-1">
          {clickyStopKeys().map((key) => (
            <kbd
              className="rounded-md border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-sans text-xs text-zinc-700"
              key={key}
            >
              {key}
            </kbd>
          ))}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {last ? null : (
          <Button
            className="text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900"
            onClick={finish}
            size="sm"
            variant="ghost"
          >
            {t("Skip")}
          </Button>
        )}
        <Button onClick={() => (last ? finish() : setPage(page + 1))} size="sm">
          {last ? t("Got it") : t("Next")}
        </Button>
      </div>
    </section>
  );
});

ClickyOnboarding.displayName = "ClickyOnboarding";
