import { useCallback, useState } from "react";
import {
  applyBotPanelOpen,
  type BotPanelTab,
  readBotPanelOpen,
} from "@/lib/bot-panel";
import { useComputerAttention } from "@/lib/computers/attention";

/**
 * The page's side of the bot panel: what is open, which tab, and what each control does.
 *
 * Three things can open the panel, and they are kept apart because they end differently. The
 * stored preference (`lib/bot-panel.ts`) opens the inline pane until somebody closes it. A
 * `?panel=` in the URL opens it for that visit, in either shape, on the tab it names. The Bot
 * asking for attention (`lib/computers/attention.ts`) opens it on its screen for this run only.
 * The close X ends all three at once: it writes the preference, clears the parameter and dismisses
 * the run. The pill and the toggle write the preference and set the parameter, so what they opened
 * stays open.
 *
 * `overlay` is reported back by the panel: a preference does not open a sheet, so a toggle that
 * said "Hide details" over a closed sheet would close something that was never showing.
 */
export function useBotPanel({
  computerAgentId,
  panel,
  setPanel,
}: {
  /** The Bot whose computer may ask for attention. Absent for a group, which has no one screen. */
  computerAgentId: string | undefined;
  /** The `?panel=` parameter as the route parsed it. */
  panel: BotPanelTab | undefined;
  /** Writes `?panel=`; undefined removes it. */
  setPanel: (tab: BotPanelTab | undefined) => void;
}) {
  const [storedOpen, setStoredOpen] = useState(() => readBotPanelOpen());
  const [overlay, setOverlay] = useState(false);
  const attention = useComputerAttention(computerAgentId);

  const defaultTab: BotPanelTab =
    computerAgentId !== undefined && attention.hasComputer
      ? "computer"
      : "details";
  // What the URL names wins; a Bot's run asks only when nothing has been asked for.
  const tab: BotPanelTab = panel ?? attention.tab ?? defaultTab;
  const demanded = attention.open || panel !== undefined;
  const isOpen = demanded || (storedOpen && !overlay);

  const close = useCallback(() => {
    applyBotPanelOpen(false);
    setStoredOpen(false);
    attention.dismiss();
    setPanel(undefined);
  }, [attention.dismiss, setPanel]);

  const openOn = useCallback(
    (next: BotPanelTab) => {
      applyBotPanelOpen(true);
      setStoredOpen(true);
      setPanel(next);
    },
    [setPanel],
  );

  return {
    tab,
    isOpen,
    /** Whether something asked for the panel, as opposed to the standing preference. */
    demanded,
    storedOpen,
    needsYou: attention.needsYou,
    close,
    openDetails: () => openOn("details"),
    toggle: () => (isOpen ? close() : openOn(tab)),
    setTab: setPanel,
    onOverlayChange: setOverlay,
  };
}
