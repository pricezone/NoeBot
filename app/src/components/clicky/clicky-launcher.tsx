import { IconPointer } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { clickyCommandMutationOptions } from "@/lib/clicky/mutations";
import { CLICKY_NAME } from "@/lib/clicky/notices";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import type { ClickySession } from "../../../../shared/clicky";
import { ClickyStateChip } from "./clicky-state-chip";

/**
 * Clicky on and off: the viewer's header toggle, pressed while Clicky is awake.
 *
 * One name, "Clicky", whatever its state: a toggle says on or off with `aria-pressed`, and a name
 * that changed with it would announce the opposite of what a press does. Waking it says hello and
 * shows the bar; putting it to sleep clears its pointer, drops anything it was asking, and stops it
 * acting (`sleep` in `shared/clicky-state.ts`).
 */
export const ClickyLauncher = memo(function ClickyLauncher({
  botId,
  session,
}: {
  botId: string;
  session: Pick<ClickySession, "awake" | "state"> | undefined;
}) {
  const command = useMutation(
    clickyCommandMutationOptions(queryClient, botId),
    queryClient,
  );
  const awake = session?.awake === true;
  return (
    <Button
      aria-pressed={awake}
      className={cn(
        "gap-1.5",
        awake
          ? "bg-white text-zinc-900 hover:bg-white/90"
          : "text-white hover:bg-white/10 hover:text-white dark:hover:bg-white/10",
      )}
      disabled={!session || command.isPending}
      onClick={() => command.mutate({ type: awake ? "sleep" : "wake" })}
      size="sm"
      variant={awake ? "default" : "ghost"}
    >
      <IconPointer aria-hidden="true" />
      {CLICKY_NAME}
    </Button>
  );
});

ClickyLauncher.displayName = "ClickyLauncher";

/**
 * Clicky under the panel's preview of the screen: where it is, and a way to wake it, which also opens
 * the screen full-window, where Clicky's bar is.
 */
export const ClickyPanelRow = memo(function ClickyPanelRow({
  botId,
  session,
  onOpenScreen,
}: {
  botId: string;
  session: Pick<ClickySession, "awake" | "state"> | undefined;
  onOpenScreen: () => void;
}) {
  const { t } = useTranslation();
  const command = useMutation(
    clickyCommandMutationOptions(queryClient, botId),
    queryClient,
  );
  const awake = session?.awake === true;
  return (
    <div
      className="flex items-center justify-between gap-2 border-t px-3 py-2"
      data-slot="clicky-panel-row"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <span className="font-medium">{CLICKY_NAME}</span>
        <ClickyStateChip className="bg-muted" session={session} />
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {awake ? (
          <>
            <Button onClick={onOpenScreen} size="sm" variant="ghost">
              {t("Open screen")}
            </Button>
            <Button
              disabled={command.isPending}
              onClick={() => command.mutate({ type: "sleep" })}
              size="sm"
              variant="ghost"
            >
              {t("Sleep")}
            </Button>
          </>
        ) : (
          <Button
            disabled={!session || command.isPending}
            onClick={() => {
              command.mutate({ type: "wake" });
              onOpenScreen();
            }}
            size="sm"
            variant="outline"
          >
            {t("Ask Clicky")}
          </Button>
        )}
      </span>
    </div>
  );
});

ClickyPanelRow.displayName = "ClickyPanelRow";
