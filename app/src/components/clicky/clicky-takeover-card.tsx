import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  CLICKY_PERSON_ONLY_TRIGGERS,
  type ClickyCommand,
  type ClickyTrigger,
  type ClickyTriggerKind,
} from "../../../../shared/clicky";
import type { ClickyActionPolicy } from "../../../../shared/user-preferences";

/** The triggers that are the Bot needing the person, as opposed to somebody asking. */
const BOT_NEEDS: readonly ClickyTriggerKind[] = [
  "takeover",
  "sign_in",
  "secret",
  "approval",
  "challenge",
];

export function isBotNeed(trigger: ClickyTrigger | null | undefined): boolean {
  return trigger ? BOT_NEEDS.includes(trigger.kind) : false;
}

/**
 * The Bot needs the person on its computer, and Clicky opened by itself to help.
 *
 * Like HeyClicky's teacher beside the cursor: what the Bot needs, in its own words, and the two ways
 * to go on. "I'll guide you" keeps Clicky pointing while the person does it; "Do it for me" lets
 * Clicky propose the actions, each still waiting for a yes. Not offered for a sign-in, a secret or a
 * challenge, which only the person may do, nor for somebody whose setting is guide only.
 */
export const ClickyTakeoverCard = memo(function ClickyTakeoverCard({
  trigger,
  actionPolicy,
  busy,
  onCommand,
  onGuide,
}: {
  trigger: ClickyTrigger;
  /** The person's setting; null until it has loaded, when "Do it for me" is not offered yet. */
  actionPolicy: ClickyActionPolicy | null;
  busy: boolean;
  onCommand: (command: ClickyCommand) => void;
  /** "I'll guide you": the person goes on with Clicky pointing, and the card goes away. */
  onGuide: () => void;
}) {
  const { t } = useTranslation();
  const mayAct =
    actionPolicy !== null &&
    actionPolicy !== "never" &&
    !CLICKY_PERSON_ONLY_TRIGGERS.includes(trigger.kind);
  return (
    <section
      aria-label={t("Noë Bot needs you here")}
      className="flex flex-col gap-2 rounded-xl bg-white p-3 text-zinc-900 shadow-lg"
      data-clicky-card="takeover"
    >
      <div>
        <p className="font-medium text-[15px]">{t("Noë Bot needs you here")}</p>
        {trigger.reason ? (
          <p className="mt-0.5 text-sm text-zinc-600">{trigger.reason}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={onGuide} size="sm">
          {t("I'll guide you")}
        </Button>
        {mayAct ? (
          <Button
            className="border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100"
            disabled={busy}
            onClick={() => onCommand({ type: "set_mode", mode: "act" })}
            size="sm"
            variant="outline"
          >
            {t("Do it for me")}
          </Button>
        ) : null}
      </div>
    </section>
  );
});

ClickyTakeoverCard.displayName = "ClickyTakeoverCard";
