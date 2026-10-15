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

/**
 * "Show me how" (Clicky) on and off: the viewer's header toggle, pressed while it is awake.
 *
 * One name, "Show me how", whatever its state: a toggle says on or off with `aria-pressed`, and a name
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
  const { t } = useTranslation();
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
      {t(CLICKY_NAME)}
    </Button>
  );
});

ClickyLauncher.displayName = "ClickyLauncher";
