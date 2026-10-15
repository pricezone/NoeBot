import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  CLICKY_RESUME_WINDOW_MS,
  type ClickySession,
  newClickySession,
  normalizeClickySession,
} from "../../../shared/clicky";
import type { Database } from "../db/client";
import { clickySessions } from "../db/schema";

/**
 * Where Clicky sessions are kept: one open session per person and Bot computer.
 *
 * The session is one JSON document written whole (see `db/schema/clicky.ts`), and every write is
 * compare-and-set on `seq`: the reducer bumps it on every change, so a writer that read seq 7 writes
 * only where the row still says 7. Two replicas, or a person's command racing the model's answer,
 * cannot write over each other; the loser reads again and reduces again (`service.ts`).
 *
 * A session is brought up to this version of the protocol as it is read (`normalizeClickySession`):
 * fields added since it was written get their defaults, and a grant from before "Allow for this
 * session" is dropped rather than widened.
 */
export type ClickyStore = {
  /** The open session, or null. Never creates one. */
  load(userId: string, botId: string): Promise<ClickySession | null>;
  /**
   * The open session, or a fresh asleep one when there is none, or when the last one was left
   * longer than the resume window ago (that one is put away first).
   */
  open(
    userId: string,
    botId: string,
    now: number,
  ): Promise<{ session: ClickySession; created: boolean }>;
  /** Writes when the stored `seq` is still `expectedSeq`; false when somebody else wrote first. */
  save(
    userId: string,
    botId: string,
    session: ClickySession,
    expectedSeq: number,
  ): Promise<boolean>;
};

/** Whether a session was left long enough ago that coming back starts over. */
export function pastResumeWindow(session: ClickySession, now: number): boolean {
  const at = Date.parse(session.updatedAt);
  return !Number.isFinite(at) || now - at > CLICKY_RESUME_WINDOW_MS;
}

export function createClickyStore(database: Database): ClickyStore {
  const openRow = async (userId: string, botId: string) =>
    (
      await database
        .select()
        .from(clickySessions)
        .where(
          and(
            eq(clickySessions.userId, userId),
            eq(clickySessions.botId, botId),
            isNull(clickySessions.endedAt),
          ),
        )
        .limit(1)
    )[0];

  const store: ClickyStore = {
    async load(userId, botId) {
      const session = (await openRow(userId, botId))?.session;
      return session ? normalizeClickySession(session) : null;
    },

    async open(userId, botId, now) {
      // Twice at most: a fresh session racing another replica's fresh session for the same person
      // loses on the unique index, and the winner's is the one to use.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const row = await openRow(userId, botId);
        if (row && !pastResumeWindow(row.session, now))
          return {
            session: normalizeClickySession(row.session),
            created: false,
          };
        if (row)
          await database
            .update(clickySessions)
            .set({ endedAt: new Date(now) })
            .where(
              and(
                eq(clickySessions.id, row.id),
                isNull(clickySessions.endedAt),
              ),
            );
        const session = newClickySession({ id: randomUUID(), botId, now });
        try {
          await database.insert(clickySessions).values({
            id: session.id,
            userId,
            botId,
            session,
            seq: session.seq,
            createdAt: new Date(now),
            updatedAt: new Date(now),
          });
          return { session, created: true };
        } catch (error) {
          if (attempt > 0) throw error;
        }
      }
      throw new Error("Show me how could not open a session.");
    },

    async save(userId, botId, session, expectedSeq) {
      const written = await database
        .update(clickySessions)
        .set({ session, seq: session.seq, updatedAt: new Date() })
        .where(
          and(
            eq(clickySessions.id, session.id),
            eq(clickySessions.userId, userId),
            eq(clickySessions.botId, botId),
            eq(clickySessions.seq, expectedSeq),
            isNull(clickySessions.endedAt),
          ),
        )
        .returning({ id: clickySessions.id });
      return written.length === 1;
    },
  };
  return store;
}

/**
 * The same contract in memory, for tests and for a server without a database. One process only:
 * nothing here is seen by another replica.
 */
export function createInMemoryClickyStore(): ClickyStore & {
  /** Every session ever opened, ended ones included, for a test to look at. */
  all(): ClickySession[];
} {
  const open = new Map<string, ClickySession>();
  const ended: ClickySession[] = [];
  const key = (userId: string, botId: string) => `${userId}\u0000${botId}`;
  return {
    async load(userId, botId) {
      const session = open.get(key(userId, botId));
      return session ? normalizeClickySession(session) : null;
    },
    async open(userId, botId, now) {
      const current = open.get(key(userId, botId));
      if (current && !pastResumeWindow(current, now))
        return { session: normalizeClickySession(current), created: false };
      if (current) ended.push(current);
      const session = newClickySession({ id: randomUUID(), botId, now });
      open.set(key(userId, botId), session);
      return { session, created: true };
    },
    async save(userId, botId, session, expectedSeq) {
      const current = open.get(key(userId, botId));
      if (!current || current.id !== session.id || current.seq !== expectedSeq)
        return false;
      open.set(key(userId, botId), session);
      return true;
    },
    all() {
      return [...ended, ...open.values()];
    },
  };
}
