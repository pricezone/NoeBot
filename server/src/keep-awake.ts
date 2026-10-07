/**
 * Keeping the machine awake while a Bot is working in it.
 *
 * A hosted deployment can be put to sleep when nobody uses it: Fly's proxy suspends a machine that
 * has had no requests for a few minutes and resumes it, in well under a second, on the next one.
 * Requests are the only thing it watches. A Bot still working after the person closed the tab makes
 * none, so the machine would be suspended mid-task. While something is in progress this sends one
 * request to the deployment's own public address a minute, through the proxy, which is all it takes
 * to count as in use; when nothing is, it sends nothing and the machine can sleep.
 *
 * Off unless `OPENBOT_KEEP_AWAKE=on`, which only a deployment that sleeps (the hosted Noë Bot) sets.
 */

/** What says a Bot is busy, read fresh on every tick. */
export type BusySignals = {
  /** Background turns started recently and not stopped (routines, triggers, follow-ups, hops). */
  recentTurns: number;
  /** Queued work currently held by a worker. */
  leasedWork: number;
  /** When a Bot's browser was last asked for, or null with none running. */
  browserLastUsedAt: Date | null;
};

/** How recently a browser must have been used to count as a Bot working in it. */
export const BROWSER_BUSY_MS = 5 * 60_000;

export function isBusy(signals: BusySignals, now = Date.now()): boolean {
  if (signals.recentTurns > 0 || signals.leasedWork > 0) return true;
  const used = signals.browserLastUsedAt?.getTime();
  return used !== undefined && now - used < BROWSER_BUSY_MS;
}

export function startKeepAwake({
  publicUrl,
  signals,
  intervalMs = 60_000,
  fetchImpl = fetch,
  log = (event) => console.info(JSON.stringify(event)),
}: {
  publicUrl: string;
  signals: () => Promise<BusySignals>;
  intervalMs?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  log?: (event: Record<string, unknown>) => void;
}): { tick: () => Promise<boolean>; stop: () => void } {
  const target = `${publicUrl.replace(/\/$/, "")}/health`;
  let awake = false;

  /** One check: ping when busy. Answers whether it pinged. */
  const tick = async (): Promise<boolean> => {
    const busy = await signals()
      .then((read) => isBusy(read))
      // A signal that cannot be read is treated as work in progress: sleeping through a task is the
      // costly mistake, a minute of staying up is not.
      .catch(() => true);
    if (busy !== awake) {
      awake = busy;
      log({ type: "keep-awake", busy });
    }
    if (!busy) return false;
    await fetchImpl(target, { signal: AbortSignal.timeout(10_000) }).catch(
      () => undefined,
    );
    return true;
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
