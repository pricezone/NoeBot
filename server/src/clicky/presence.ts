/**
 * Who is watching which Bot's screen, and whether that Bot is at work for them, as this process sees
 * it: what Show me how's narration starts on.
 *
 * The full-window viewer is exactly an open live-screen socket, so the relay says when one opens and
 * closes (`viewerOpen`). A Bot is at work for a person while one of its runs holds a thread for them
 * (`runBusy`, from the run lock) or when it acted on its page in the last few seconds (`botActed`):
 * a person who opens the screen then is shown what the Bot is doing.
 *
 * Kept in memory, per process, like the holders of the computers: hosted instances run one replica.
 * On another replica the viewer would not be seen, and the Bot's actions would simply not be narrated.
 */

/** How long after the Bot's last action it still counts as at work. */
export const BOT_ACTIVE_MS = 15_000;

export type ClickyPresence = ReturnType<typeof createClickyPresence>;

export function createClickyPresence(
  options: { now?: () => number; activeMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const activeMs = options.activeMs ?? BOT_ACTIVE_MS;
  const key = (userId: string, botId: string) => `${userId}\u0000${botId}`;
  const viewers = new Map<string, number>();
  const runs = new Map<string, string>();
  const acted = new Map<string, number>();

  return {
    /** A live-screen socket of this person's on this Bot opened (`true`) or closed (`false`). */
    viewerOpen(userId: string, botId: string, open: boolean) {
      const at = key(userId, botId);
      const count = (viewers.get(at) ?? 0) + (open ? 1 : -1);
      if (count > 0) viewers.set(at, count);
      else viewers.delete(at);
    },

    /** Whether this person has this Bot's screen open. */
    viewing(userId: string, botId: string): boolean {
      return (viewers.get(key(userId, botId)) ?? 0) > 0;
    },

    /** A run took or gave back a thread's lock (the same event the activation hears). */
    runBusy(input: {
      threadId: string;
      busy: boolean;
      userId?: string;
      agentId?: string;
    }) {
      if (input.busy && input.userId && input.agentId) {
        runs.set(input.threadId, key(input.userId, input.agentId));
        // A run whose end was never heard is forgotten eventually, oldest first.
        if (runs.size > 1000) {
          const oldest = runs.keys().next().value;
          if (oldest !== undefined) runs.delete(oldest);
        }
      } else if (!input.busy) runs.delete(input.threadId);
    },

    /** The Bot acted on its page for this person. */
    botActed(userId: string, botId: string) {
      acted.set(key(userId, botId), now());
      if (acted.size > 1000) {
        const oldest = acted.keys().next().value;
        if (oldest !== undefined) acted.delete(oldest);
      }
    },

    /** Whether this Bot is at work for this person: a run in hand, or an action just now. */
    botActive(userId: string, botId: string): boolean {
      const at = key(userId, botId);
      for (const running of runs.values()) if (running === at) return true;
      const last = acted.get(at);
      return last !== undefined && now() - last <= activeMs;
    },
  };
}
