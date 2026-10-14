import { IconPlayerStopFilled } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { agentQueryOptions } from "@/lib/agents/queries";
import { CLICKY_STOP_ARIA, useClickyStopShortcut } from "@/lib/clicky/keyboard";

import { type ClickyChipState, chipStateOf } from "@/lib/clicky/notices";
import { useClickyCapability } from "@/lib/clicky/queries";
import { useShownClickySessions } from "@/lib/clicky/shown-sessions";
import { stopClickyNow, useClickyStopFailed } from "@/lib/clicky/stop";
import {
  selectClickyPresence,
  useClickySession,
} from "@/lib/clicky/use-clicky-session";
import { useTranslation } from "@/lib/i18n";
import { queryClient } from "@/query-client";

const BUSY: readonly ClickyChipState[] = ["acting", "awaiting_permission"];

/**
 * Watches one Bot's session for the pill, and draws the pill while Clicky is doing something there
 * (or waiting for a yes) and no viewer is showing its own Stop, or while a Stop for it did not get
 * through, which is never left unsaid.
 */
const ClickyWatch = memo(function ClickyWatch({
  botId,
  inViewer,
  onState,
}: {
  botId: string;
  inViewer: boolean;
  onState: (botId: string, state: ClickyChipState | null) => void;
}) {
  const { t } = useTranslation();
  const presence = useClickySession(botId, true, "watch", selectClickyPresence);
  const state = chipStateOf(presence);
  const stopFailed = useClickyStopFailed(botId);
  const bot = useQuery(agentQueryOptions(botId), queryClient);
  useEffect(() => onState(botId, state), [botId, state, onState]);
  useEffect(() => () => onState(botId, null), [botId, onState]);
  if (inViewer || !(BUSY.includes(state) || stopFailed)) return null;
  const name = bot.data?.name ?? "Noë Bot";
  return (
    <div
      className="pointer-events-auto flex items-center gap-3 rounded-full bg-zinc-900 py-1.5 pr-1.5 pl-4 text-sm text-white shadow-lg ring-1 ring-white/10"
      data-clicky="stop-pill"
      data-clicky-ui
      role={stopFailed ? "alert" : "status"}
    >
      <span>
        {stopFailed
          ? t("Clicky couldn't be stopped. Try again.")
          : state === "acting"
            ? t("Clicky is doing something on {{name}}'s computer.", { name })
            : t("Clicky is waiting for your OK on {{name}}'s computer.", {
                name,
              })}
      </span>
      <Button
        aria-keyshortcuts={CLICKY_STOP_ARIA}
        className="rounded-full bg-red-600 text-white hover:bg-red-500"
        onClick={() => void stopClickyNow(queryClient, botId)}
        size="sm"
      >
        <IconPlayerStopFilled aria-hidden="true" />
        {t("Stop")}
      </Button>
    </div>
  );
});

ClickyWatch.displayName = "ClickyWatch";

/**
 * Stop, from anywhere in the app, while Clicky is acting on a computer.
 *
 * Mounted once, in the signed-in shell. It follows every Bot whose Clicky this tab is showing
 * (`shown-sessions.ts`), and keeps following one that is acting or waiting for a yes after the person
 * has navigated away from it, so a pill with a Stop on it stays in front of them until Clicky is done.
 * Control-Option-S (Ctrl+Alt+S) stops every Clicky that is awake here, whatever has focus.
 */
export function ClickyStopPill() {
  const { enabled } = useClickyCapability();
  const shown = useShownClickySessions();
  const [states, setStates] = useState<ReadonlyMap<string, ClickyChipState>>(
    () => new Map(),
  );
  const onState = useCallback(
    (botId: string, state: ClickyChipState | null) =>
      setStates((previous) => {
        if (previous.get(botId) === (state ?? undefined)) return previous;
        const next = new Map(previous);
        if (state === null) next.delete(botId);
        else next.set(botId, state);
        return next;
      }),
    [],
  );

  const watched = new Map<string, boolean>();
  for (const entry of shown) watched.set(entry.botId, entry.inViewer);
  for (const [botId, state] of states)
    if (BUSY.includes(state) && !watched.has(botId)) watched.set(botId, false);

  useClickyStopShortcut(
    () => {
      for (const [botId, state] of states)
        if (state !== "asleep" && state !== "stopped")
          void stopClickyNow(queryClient, botId);
    },
    enabled && states.size > 0,
  );

  if (!enabled || watched.size === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4">
      {[...watched].map(([botId, inViewer]) => (
        <ClickyWatch
          botId={botId}
          inViewer={inViewer}
          key={botId}
          onState={onState}
        />
      ))}
    </div>
  );
}
