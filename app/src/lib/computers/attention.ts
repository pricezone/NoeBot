import { useCallback, useEffect, useRef, useState } from "react";
import { onComputerActivity } from "@/lib/copilot/computer-activity";
import { useComputerControl } from "@/lib/computers/use-control";

/**
 * When a Bot's computer wants the person's eyes: the bot panel opens on its screen, for this
 * session only.
 *
 * Two things ask for attention. The Bot starting to use its computer opens the panel once per
 * run — an activity epoch from `lib/copilot/computer-activity.ts` — unless the person closed it
 * during that same run, in which case the run stays closed and the next one asks again. And the
 * Bot needing the person — a hand-off request, a secret, an interrupted browser, or the person
 * already holding the wheel — opens it once per prompt.
 *
 * REACT STATE, NEVER THE STORED PREFERENCE. The preference in `lib/bot-panel.ts` records what the
 * person chose. A panel that opened itself must not write "open" over a "closed" the person wrote,
 * or an explicit close would last exactly until the Bot's next command. So this holds its own
 * "open for this session" flag, and the page ORs it with the preference. `dismiss` is the close X:
 * it drops the flag and marks the current run as dismissed.
 */
export function useComputerAttention(agentId: string | undefined): {
  /** Whether attention is asked for right now; the page opens the panel while it is. */
  open: boolean;
  /** The tab attention wants, which is always the screen, or null when none is asked for. */
  tab: "computer" | null;
  /** Whether the Bot is waiting on the person, for a dot beside the toggle. */
  needsYou: boolean;
  /**
   * Whether this Bot has a computer to show. True until the control poll has failed to find one,
   * so the panel opens on the screen without a flicker through Details while the first poll runs.
   */
  hasComputer: boolean;
  /** Closes the panel for this run: the same run will not reopen it. */
  dismiss: () => void;
} {
  /*
   * Which Bot the flag is for, rather than a bare boolean: a conversation with another Bot is not
   * the one that asked, so switching Bots clears it without an effect that sets state.
   */
  const [openFor, setOpenFor] = useState<string | null>(null);
  const dismissedEpoch = useRef<number | null>(null);
  const runEpoch = useRef<number | null>(null);

  useEffect(() => {
    if (!agentId) return;
    return onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      if (dismissedEpoch.current === activity.epoch) return;
      setOpenFor(agentId);
    });
  }, [agentId]);

  const { control, problem } = useComputerControl(
    agentId ?? "",
    Boolean(agentId),
  );
  // The store reports a failed read as a null control beside a "Reconnecting" problem.
  const hasComputer = control !== null || problem === null;
  const needsYou = Boolean(
    control &&
      (control.requested ||
        control.holder === "human" ||
        control.request?.status === "interrupted" ||
        control.secretWanted !== undefined),
  );
  const promptKey =
    needsYou && agentId
      ? `${agentId}:${control?.secretWanted ?? control?.request?.id ?? "human"}`
      : null;
  const shownPrompt = useRef<string | null>(null);
  useEffect(() => {
    if (shownPrompt.current === promptKey) return;
    shownPrompt.current = promptKey;
    // Surface each new prompt once; closing the panel remains a real dismissal.
    if (promptKey && agentId) setOpenFor(agentId);
  }, [promptKey, agentId]);

  const dismiss = useCallback(() => {
    // Dismissal applies only to the current browser-activity run.
    dismissedEpoch.current = runEpoch.current;
    setOpenFor(null);
  }, []);

  const open = agentId !== undefined && openFor === agentId;
  return {
    open,
    tab: open ? "computer" : null,
    needsYou,
    hasComputer,
    dismiss,
  };
}
