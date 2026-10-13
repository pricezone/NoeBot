import { useCallback, useEffect, useSyncExternalStore } from "react";
import { onComputerActivity } from "@/lib/copilot/computer-activity";

/**
 * When a Bot's computer view goes to sleep, and what wakes it.
 *
 * Grok's computer sleeps when nobody is using it and wakes where it left off. Here the screen in the
 * bot panel asked for a screenshot every second for as long as it was open, and on the shared
 * computer every screenshot touches the browser, so an open panel kept a browser alive for ever and
 * the computer's own idle sweep never ran. Asleep, the panel and the full-window viewer ask for
 * nothing at all and say so; waking is one press, and the first screenshot after it starts the
 * browser again with the tabs it had (agent-computer's saved-tabs.ts).
 *
 * WHAT COUNTS AS SOMEBODY USING IT, each of which resets the timer and wakes a sleeping computer:
 * the Bot reaching its computer (`reportComputerActivity`, and every computer tool through
 * `noteComputerActivity`), the person typing in or sending from that Bot's conversation, a click or a
 * key in the computer panel or the viewer, and a Bot turn starting. Nothing else: a panel somebody
 * is merely looking at is the case this exists for.
 *
 * ONE STATE PER BOT, OUTSIDE REACT, so the panel's card and the viewer it opens agree, and so does a
 * second card on the same Bot. The clock and the timers are injectable for the tests.
 */

/** How long nothing may happen before a Bot's computer view goes to sleep. */
export const DEFAULT_COMPUTER_SLEEP_MS = 10 * 60_000;

/** Minutes from the environment, as milliseconds; the default for anything that is not a positive number. */
export function sleepAfterFrom(minutes: unknown): number {
  const value =
    typeof minutes === "number"
      ? minutes
      : typeof minutes === "string" && minutes.trim() !== ""
        ? Number(minutes)
        : Number.NaN;
  return Number.isFinite(value) && value > 0
    ? value * 60_000
    : DEFAULT_COMPUTER_SLEEP_MS;
}

function sleepMinutesFromEnv(): unknown {
  try {
    return (import.meta.env as Record<string, unknown> | undefined)
      ?.VITE_COMPUTER_SLEEP_MINUTES;
  } catch {
    return undefined;
  }
}

/** Ten minutes, or `VITE_COMPUTER_SLEEP_MINUTES` for development and tests. */
export const COMPUTER_SLEEP_MS = sleepAfterFrom(sleepMinutesFromEnv());

export type SleepClock = {
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

const realClock: SleepClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => {
    const timer = setTimeout(run, ms);
    // A sleep timer is housekeeping; it must not hold a process (or a test run) open.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createComputerSleep({
  sleepMs = COMPUTER_SLEEP_MS,
  clock = realClock,
}: {
  sleepMs?: number;
  clock?: SleepClock;
} = {}) {
  type Entry = {
    asleep: boolean;
    /** The last activity, or undefined when nothing has happened since this page started watching. */
    activeAt: number | undefined;
    timer: unknown;
  };
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const stopTimer = (entry: Entry) => {
    if (entry.timer === undefined) return;
    clock.clearTimer(entry.timer);
    entry.timer = undefined;
  };
  const fallAsleep = (entry: Entry) => {
    stopTimer(entry);
    if (entry.asleep) return;
    entry.asleep = true;
    notify();
  };
  const startTimer = (entry: Entry) => {
    stopTimer(entry);
    entry.timer = clock.setTimer(() => {
      entry.timer = undefined;
      fallAsleep(entry);
    }, sleepMs);
  };
  const entryFor = (botId: string): Entry => {
    const existing = entries.get(botId);
    if (existing) return existing;
    const entry: Entry = {
      asleep: false,
      activeAt: undefined,
      timer: undefined,
    };
    entries.set(botId, entry);
    // A view left open with nothing happening at all sleeps too, counted from when it was first seen.
    startTimer(entry);
    return entry;
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Whether this Bot's computer view is asleep. A Bot nobody has watched yet is awake. */
    isAsleep(botId: string): boolean {
      return entries.get(botId)?.asleep ?? false;
    },

    /** Start counting for a Bot a view has just been opened on. Changes nothing for one already counted. */
    watch(botId: string): void {
      entryFor(botId);
    },

    /** Somebody is using it: reset the timer, and wake it if it was asleep. */
    activity(botId: string): void {
      const entry = entryFor(botId);
      entry.activeAt = clock.now();
      startTimer(entry);
      if (!entry.asleep) return;
      entry.asleep = false;
      notify();
    },

    /**
     * The computer says its browser is not running: asleep, unless something has happened here
     * within the sleep window. A Bot that was just used is awake whatever the browser is doing, and
     * the next screenshot starts it.
     */
    sleepIfQuiet(botId: string): void {
      const entry = entryFor(botId);
      const quiet =
        entry.activeAt === undefined || clock.now() - entry.activeAt >= sleepMs;
      if (quiet) fallAsleep(entry);
    },

    /** Asleep now, whatever has happened. For a test that starts from a sleeping computer. */
    sleep(botId: string): void {
      fallAsleep(entryFor(botId));
    },

    /** Forget every Bot. For tests. */
    reset(): void {
      for (const entry of entries.values()) stopTimer(entry);
      entries.clear();
      notify();
    },
  };
}

export type ComputerSleep = ReturnType<typeof createComputerSleep>;

/** The one this page uses. */
export const computerSleep = createComputerSleep();

// The Bot reaching its computer is the first thing that keeps it awake, wherever it was reached from.
onComputerActivity(({ botId }) => computerSleep.activity(botId));

/** Somebody used this Bot's computer, or is about to: the composer, a send, a turn, a tool. */
export function noteComputerActivity(botId: string): void {
  if (botId) computerSleep.activity(botId);
}

/** The computer says this Bot's browser is not running. See `sleepIfQuiet`. */
export function sleepComputerIfQuiet(botId: string): void {
  computerSleep.sleepIfQuiet(botId);
}

/**
 * A conversation's half: a turn starting with this Bot, and the person typing or sending to it.
 *
 * The turn is counted on its rising edge, so a long turn that never touches the computer does not
 * hold it awake (one that does wakes it through the computer call). The answer is for the person's
 * side: call it from the composer's input (bubbled, so any field in the conversation counts) and
 * on a send.
 */
export function useConversationActivity(
  botId: string,
  turnBusy: boolean,
): () => void {
  useEffect(() => {
    if (turnBusy) noteComputerActivity(botId);
  }, [turnBusy, botId]);
  return useCallback(() => noteComputerActivity(botId), [botId]);
}

/**
 * Whether this Bot's computer view is asleep, and the way to wake it.
 *
 * `enabled` false is a view that never sleeps (a finished turn's tile, which polls nothing anyway):
 * it reads awake and starts no timer.
 */
export function useComputerSleep(
  botId: string,
  {
    enabled = true,
    store = computerSleep,
  }: { enabled?: boolean; store?: ComputerSleep } = {},
): { asleep: boolean; wake: () => void } {
  useEffect(() => {
    if (enabled && botId) store.watch(botId);
  }, [botId, enabled, store]);
  const asleep = useSyncExternalStore(
    store.subscribe,
    () => enabled && store.isAsleep(botId),
    () => false,
  );
  const wake = useCallback(() => store.activity(botId), [botId, store]);
  return { asleep, wake };
}
