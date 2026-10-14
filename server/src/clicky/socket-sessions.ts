/**
 * Clicky's sockets end with the session they were opened on.
 *
 * A WebSocket is authenticated once, when it opens, and then stays open for as long as the client
 * likes. A phone that is signed out from Settings, or whose day is over, must not go on hearing the
 * person's screen: so each socket is kept with the session token it was opened with, closed at once
 * when that phone is revoked, and every minute any socket whose session is gone or expired is closed
 * too. The client then reconnects, and the guard in front of the socket answers for the session it
 * has now.
 */

export const SESSION_SWEEP_MS = 60_000;

/** The close code a socket gets when its session ended: an application code, "signed out". */
export const SIGNED_OUT_CLOSE = 4401;

export type SocketSessions = {
  /** Keep one socket with its session token; null when it has none to check. Returns the detach. */
  watch(token: string | null, close: () => void): () => void;
  /** A phone signed out: close every socket opened with its session. */
  revoke(token: string): void;
  /** Close the sockets whose session is gone or over. */
  sweep(): Promise<void>;
  start(): void;
  stop(): void;
  size(): number;
};

export function createSocketSessions(deps: {
  /** Of these tokens, the ones whose session still exists and has not expired. */
  alive: (tokens: string[]) => Promise<Set<string>>;
  intervalMs?: number;
}): SocketSessions {
  const sockets = new Map<() => void, string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const closeAll = (token: string) => {
    for (const [close, held] of [...sockets]) {
      if (held !== token) continue;
      sockets.delete(close);
      try {
        close();
      } catch {
        // Already closing.
      }
    }
  };
  const sessions: SocketSessions = {
    watch(token, close) {
      if (token) sockets.set(close, token);
      return () => {
        sockets.delete(close);
      };
    },
    revoke(token) {
      closeAll(token);
    },
    async sweep() {
      const tokens = [...new Set(sockets.values())];
      if (tokens.length === 0) return;
      const alive = await deps.alive(tokens);
      for (const token of tokens) if (!alive.has(token)) closeAll(token);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void sessions.sweep().catch(() => undefined);
      }, deps.intervalMs ?? SESSION_SWEEP_MS);
      (timer as { unref?: () => void }).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    size() {
      return sockets.size;
    },
  };
  return sessions;
}
