import { IconPointer } from "@tabler/icons-react";
import { memo } from "react";
import { ToolLine } from "@/components/channels/tool-line";
import { useBotScreen } from "@/components/chat-cards/recovery-card";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

/** Whether the guide call's result says it worked. A result the tab cannot read counts as not. */
function guided(result: string | undefined): boolean {
  if (!result) return false;
  try {
    const value = JSON.parse(result) as unknown;
    return (
      typeof value === "object" &&
      value !== null &&
      "ok" in value &&
      value.ok === true
    );
  } catch {
    return false;
  }
}

/**
 * `computer_guide_person` in the conversation: the Bot asked Clicky to show the person where to go
 * on its screen. One line with what it is about, and a way to the screen, where Clicky is pointing.
 */
export const ClickyGuideCard = memo(function ClickyGuideCard({
  computerId,
  goal,
  running,
  result,
}: {
  computerId: string;
  goal: string;
  running: boolean;
  result?: string;
}) {
  const { t } = useTranslation();
  const { openScreen } = useBotScreen(computerId, false);
  if (running)
    return <ToolLine detail={goal} label={t("Getting Clicky ready")} running />;
  if (!guided(result))
    return (
      <ToolLine detail={goal} failed label={t("Showing you on the screen")} />
    );
  return (
    <div
      className="my-2 flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-3 py-2"
      data-clicky-card="guide"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <IconPointer
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0">
          {t("Clicky is showing you where: {{goal}}", { goal })}
        </span>
      </span>
      <Button onClick={openScreen} size="sm" variant="outline">
        {t("Open the screen")}
      </Button>
    </div>
  );
});

ClickyGuideCard.displayName = "ClickyGuideCard";
