/**
 * Browser-activity epoch used by surfaces that auto-open the live screen once per run.
 */

const QUIET_GAP_MS = 10_000;

type Activity = { botId: string; epoch: number };

let epoch = 0;
let lastAt = 0;
let lastBot: string | null = null;
/** When each Bot last reached its computer, for "is it working right now?". */
const lastByBot = new Map<string, number>();
const listeners = new Set<(activity: Activity) => void>();

/** Called wherever a Bot's computer is reached, so auto-open surfaces share one activity source. */
export function reportComputerActivity(botId: string): void {
  const now = Date.now();
  // A different Bot is always a new run, however recently the last one acted.
  if (botId !== lastBot || now - lastAt > QUIET_GAP_MS) epoch += 1;
  lastAt = now;
  lastBot = botId;
  lastByBot.set(botId, now);
  const activity = { botId, epoch };
  for (const listener of listeners) listener(activity);
}

/**
 * When this Bot last reached its computer (milliseconds since the epoch), or null if it has not in
 * this tab. Opening its screen within moments of that means it is at work there, and "Show me how"
 * narrates what it does.
 */
export function lastActivityFor(botId: string): number | null {
  return lastByBot.get(botId) ?? null;
}

export function onComputerActivity(
  listener: (activity: Activity) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
