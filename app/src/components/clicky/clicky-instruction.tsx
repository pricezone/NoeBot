import { memo } from "react";
import { instructionText } from "@/lib/clicky/notices";
import { useClickyPreferences } from "@/lib/clicky/queries";
import { usePrefersReducedMotion } from "@/lib/clicky/reduced-motion";
import { useClickyReplays } from "@/lib/clicky/replay";
import {
  useClickyReply,
  useClickySessionView,
} from "@/lib/clicky/use-clicky-session";
import { useTranslation } from "@/lib/i18n";
import { useTypedSentence } from "@/lib/typed-reveal";
import { cn } from "@/lib/utils";
import type { ClickySession } from "../../../../shared/clicky";
import { stepOf } from "./clicky-words";

/** What the instruction needs from the session, apart from the reply (read with its words arriving). */
function selectInstruction(session: ClickySession): {
  narrating: boolean;
  step: { title: string; detail?: string } | null;
} {
  const step = stepOf(session);
  return {
    narrating: session.narrating === true,
    step: step
      ? { title: step.title, ...(step.detail ? { detail: step.detail } : {}) }
      : null,
  };
}

/**
 * The instruction beside "Show me how"'s pointer, typing in (`instructionText`): the step to do, the
 * answer to what the person asked, or what the Bot is doing while Clicky narrates it.
 *
 * ITS OWN COMPONENT, SO WORDS ARRIVING DRAW ONLY IT. It reads the reply as it streams; the overlay
 * around it is drawn again only when what it points at changes.
 *
 * The typing starts again when the instruction becomes another one, and when it is said again ("Say
 * that again", here or on the phone: `useClickyReplays`); words still arriving type on from where
 * they were. With reduced motion it is simply there. The bubble is sized by the whole sentence from
 * the first letter, so it does not grow under the person's eyes as the letters land.
 *
 * Hidden from screen readers: the overlay's live region already announces the step or the reply,
 * once, rather than a letter at a time.
 *
 * `fallback` is the pointer's own label (and its "around here"), shown when there is no instruction,
 * as for overlays the bridge draws with nothing said.
 */
export const ClickyInstruction = memo(function ClickyInstruction({
  botId,
  fallback,
  approximate = false,
  className,
}: {
  botId: string;
  fallback?: string | null;
  approximate?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const view = useClickySessionView(botId, selectInstruction);
  const reply = useClickyReply(botId);
  const { clickyGuidance } = useClickyPreferences();
  const replays = useClickyReplays(botId);
  const reduce = usePrefersReducedMotion();
  const instruction = view
    ? instructionText(
        {
          narrating: view.narrating,
          step: view.step,
          reply: reply ?? null,
          detailed: clickyGuidance === "detailed",
        },
        (key, params) => t(key, params),
      )
    : "";
  const text = instruction || fallback || "";
  const typed = useTypedSentence(text, replays, reduce);
  if (!text) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block w-max max-w-64 rounded-xl bg-white px-2.5 py-1.5 text-left text-[13px] leading-snug text-zinc-900 shadow-lg ring-1 ring-black/10",
        className,
      )}
      data-clicky="instruction"
      data-typing={typed.typing ? "true" : undefined}
    >
      {/* The whole sentence, unseen, holds the bubble at its final size. */}
      <span className="invisible block whitespace-pre-line">{text}</span>
      <span
        className="absolute inset-x-2.5 top-1.5 block whitespace-pre-line"
        data-clicky="instruction-text"
      >
        {typed.text}
        {typed.typing ? (
          <span className="ml-px inline-block h-3.5 w-0.5 bg-zinc-400 align-middle" />
        ) : null}
      </span>
      {instruction && approximate ? (
        <span className="block text-[12px] text-zinc-500">
          {t("Around here")}
        </span>
      ) : null}
    </span>
  );
});

ClickyInstruction.displayName = "ClickyInstruction";
