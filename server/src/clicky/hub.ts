import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { ClickyServerEvent, ClickySession } from "../../../shared/clicky";
import type { Database } from "../db/client";

/**
 * Clicky's live events: every screen showing a session hears every change to it.
 *
 * The web app's Clicky bar and the person's phone both hold `/clicky/events` sockets for the same
 * session, and they may be on different replicas from the one that changed it. So a change is
 * announced through Postgres `NOTIFY` on {@link CLICKY_ACTIVITY_TOPIC} carrying only who and which
 * `seq` (the session itself can outgrow NOTIFY's 8 KB payload), and each replica's listener reads the
 * session back from the database and fans it out to its own sockets. The replica that made the change
 * also delivers it at once, without waiting for its own notification; a `seq` it has already
 * delivered is not sent twice.
 *
 * `reply.delta`, the model's words while they are still arriving, is NOT announced: it goes to this
 * process's sockets only. A hosted Noë Bot runs one replica, so every socket is here; on several
 * replicas a socket elsewhere sees the reply arrive whole in the next snapshot instead, which is
 * slower to read and never wrong.
 *
 * Like channel activity, this is an optimisation and never the source of truth: the session in the
 * database is, a client that sees a gap in `seq` fetches it again, and `resync` tells every socket to
 * do so after the listener has been away (a NOTIFY is never replayed).
 */

export const CLICKY_ACTIVITY_TOPIC = "clicky_activity";

/** What is announced: who, and how far the session has got. Small, always under the 8 KB cap. */
export type ClickyNote = { userId: string; botId: string; seq: number };

type Send = (event: ClickyServerEvent) => void;

export type ClickyHub = {
  /** Attach a socket for one person's session with one Bot. Returns the detach. */
  subscribe(userId: string, botId: string, send: Send): () => void;
  /** A session changed here: deliver it to this process's sockets and announce it to the rest. */
  publish(userId: string, botId: string, session: ClickySession): void;
  /**
   * Part of a reply still arriving. `seq` is that of the latest snapshot in state "thinking" for the
   * model call it belongs to. This process's sockets only.
   */
  delta(
    userId: string,
    botId: string,
    seq: number,
    thinkId: string,
    text: string,
  ): void;
  /** An announcement heard through Postgres: read the session back and deliver it if it is news. */
  hear(note: ClickyNote): Promise<void>;
  /** Tell every socket to fetch its session again: something may have been missed. */
  resyncAll(): void;
  subscribers(userId: string, botId: string): number;
};

const keyOf = (userId: string, botId: string) => `${userId}\u0000${botId}`;

export function createClickyHub(deps: {
  /** The open session, read back when another replica announces a change. */
  load: (userId: string, botId: string) => Promise<ClickySession | null>;
  /** Tells the other replicas; absent in one process with no database, such as a test. */
  announce?: (note: ClickyNote) => Promise<void>;
}): ClickyHub {
  const sockets = new Map<string, Set<Send>>();
  /** The last session delivered per key, so an echo of our own change is not sent again. */
  const delivered = new Map<string, { id: string; seq: number }>();

  const isNews = (key: string, session: ClickySession) => {
    const last = delivered.get(key);
    return !last || last.id !== session.id || session.seq > last.seq;
  };

  const send = (key: string, event: ClickyServerEvent) => {
    for (const socket of sockets.get(key) ?? []) {
      try {
        socket(event);
      } catch {
        // Closing, and detached by its own close handler. Failing here would deny the rest.
      }
    }
  };

  const deliver = (key: string, session: ClickySession) => {
    if (!isNews(key, session)) return;
    delivered.set(key, { id: session.id, seq: session.seq });
    send(key, { type: "snapshot", session });
  };

  return {
    subscribe(userId, botId, socket) {
      const key = keyOf(userId, botId);
      const set = sockets.get(key) ?? new Set<Send>();
      set.add(socket);
      sockets.set(key, set);
      return () => {
        const remaining = sockets.get(key);
        if (!remaining) return;
        remaining.delete(socket);
        if (remaining.size === 0) {
          sockets.delete(key);
          delivered.delete(key);
        }
      };
    },

    publish(userId, botId, session) {
      const key = keyOf(userId, botId);
      if (sockets.has(key)) deliver(key, session);
      void deps
        .announce?.({ userId, botId, seq: session.seq })
        .catch((error: unknown) => {
          // The sockets here already have it; elsewhere they catch up on their next fetch.
          console.warn(
            JSON.stringify({
              type: "clicky-announce-failed",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
    },

    delta(userId, botId, seq, thinkId, text) {
      if (!text) return;
      send(keyOf(userId, botId), { type: "reply.delta", seq, thinkId, text });
    },

    async hear(note) {
      const key = keyOf(note.userId, note.botId);
      // Nobody here is watching that session: nothing to read back. Read back otherwise, even for a
      // `seq` already delivered: a session that was put away and started afresh counts from zero.
      if (!sockets.has(key)) return;
      const session = await deps.load(note.userId, note.botId);
      if (session && sockets.has(key)) deliver(key, session);
    },

    resyncAll() {
      for (const key of sockets.keys()) send(key, { type: "resync" });
    },

    subscribers(userId, botId) {
      return sockets.get(keyOf(userId, botId))?.size ?? 0;
    },
  };
}

/** Announces a change to every replica, on the pool: one `select pg_notify(...)`. */
export function notifyClickyActivity(database: Database) {
  return async (note: ClickyNote) => {
    await database.execute(
      sql`select pg_notify(${CLICKY_ACTIVITY_TOPIC}, ${JSON.stringify(note)})`,
    );
  };
}

export type ClickyActivityListener = { stop: () => Promise<void> };

function isNote(value: unknown): value is ClickyNote {
  if (!value || typeof value !== "object") return false;
  const note = value as Record<string, unknown>;
  return (
    typeof note.userId === "string" &&
    typeof note.botId === "string" &&
    typeof note.seq === "number"
  );
}

/**
 * Listens for every replica's announcements, this one's included, on a connection of its own:
 * `LISTEN` holds one for the life of the subscription, which the pool would never get back. Built the
 * way the channel listener is (`channels/events.ts`): `onlisten` fires on every establish, and every
 * one after the first may have missed something, so the sockets are told to resync.
 */
export async function startClickyActivityListener(
  databaseUrl: string,
  hub: ClickyHub,
): Promise<ClickyActivityListener> {
  const connection = postgres(databaseUrl, { max: 1 });
  let subscribed = false;
  await connection.listen(
    CLICKY_ACTIVITY_TOPIC,
    (payload) => {
      let note: unknown;
      try {
        note = JSON.parse(payload);
      } catch {
        return;
      }
      if (isNote(note))
        void hub.hear(note).catch(() => {
          // The session will be fetched again by the client; the subscription stays up.
        });
    },
    () => {
      if (!subscribed) {
        subscribed = true;
        return;
      }
      hub.resyncAll();
    },
  );
  return {
    stop: async () => {
      await connection.end();
    },
  };
}
