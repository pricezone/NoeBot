import { createHash } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";
import { ApprovalNotFoundError } from "./types";

/**
 * A decision card waiting on the person, kept on the server for as long as it waits.
 *
 * `askChoice` and `askApproval` suspend the run in the tab that started it, and only that tab holds
 * what resumes it. Nothing else knew the card existed: the person's other tab, or the same tab on
 * their phone, saw the question only once the turn was over and the history caught up, and then
 * could answer it only by sending a message. So the tab running the turn writes one record per
 * card when it starts waiting, says it is still there every few seconds, and reads the record for an
 * answer given somewhere else. Answered elsewhere, it hands that answer to the waiting run; gone
 * (no word for `DECISION_STALE_MS`), the tab that answered sends the answer as a message instead.
 *
 * In `work_items` under its own kind rather than a table of its own: nothing claims that kind, so
 * no sweep ever runs one, and the row is the same "something waiting on a person" shape the
 * questions a Bot asks already use.
 */

export const WAITING_DECISION_KIND = "person.decision";

/** No word from the tab holding the run for this long, and it is taken to be gone. */
export const DECISION_STALE_MS = 15_000;

/** An open card not heard from for this long is no longer offered anywhere, and is closed. */
export const DECISION_FORGOTTEN_MS = 10 * 60_000;

const option = z.object({
  id: z.string().min(1).max(500),
  label: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
});

/** What the card asks, as the Bot wrote it: enough for another tab to draw the same card. */
export const decisionArgsSchema = z.object({
  title: z.string().trim().min(1).max(2000),
  summary: z.string().max(6000).optional(),
  options: z.array(option).max(52).optional(),
  details: z
    .array(
      z.object({ label: z.string().max(500), value: z.string().max(2000) }),
    )
    .max(40)
    .optional(),
  approveLabel: z.string().max(200).optional(),
  rejectLabel: z.string().max(200).optional(),
});

export const openDecisionSchema = z.strictObject({
  botId: z.string().trim().min(1).max(200),
  channelId: z.string().trim().min(1).max(200),
  toolCallId: z.string().trim().min(1).max(200),
  kind: z.enum(["choice", "approval"]),
  args: decisionArgsSchema,
});
export type OpenDecision = z.infer<typeof openDecisionSchema>;
export type DecisionKind = OpenDecision["kind"];

/** The two answers a decision card gives, in the shape the card hands its waiting run. */
const choiceAnswer = z.strictObject({
  choice: z.string().min(1).max(6000),
  label: z.string().min(1).max(6000),
  typed: z.literal(true).optional(),
});
const approvalAnswer = z.strictObject({
  decision: z.enum(["approved", "declined"]),
  note: z.string().max(6000).optional(),
});
export type DecisionAnswer =
  | z.infer<typeof choiceAnswer>
  | z.infer<typeof approvalAnswer>;

/** An answer checked against the kind of card it answers. Throws a ZodError when it does not fit. */
export function parseDecisionAnswer(
  kind: DecisionKind,
  answer: unknown,
): DecisionAnswer {
  return kind === "choice"
    ? choiceAnswer.parse(answer)
    : approvalAnswer.parse(answer);
}

/** What a reader gets: the card, whether its run is still held, and the answer once there is one. */
export type WaitingDecision = OpenDecision & {
  createdAt: string;
  heartbeatAt: string;
  /**
   * The tab holding the run was heard from in the last `DECISION_STALE_MS`. Decided by the server's
   * clock, so a reader's own clock cannot make a live card look abandoned.
   */
  live: boolean;
  answer: DecisionAnswer | null;
  answeredAt: string | null;
  /** Done with: answered and handed to the run, or answered as a message, or forgotten. */
  closed: boolean;
};

/**
 * Why an answer was not taken: the card was already answered or closed, or the tab holding its run
 * is gone and the answer has to travel as a message instead.
 */
export class DecisionConflictError extends Error {
  readonly reason: "answered" | "stale";
  constructor(reason: "answered" | "stale") {
    super(
      reason === "answered"
        ? "This question was already answered."
        : "The tab that asked this is gone, so the answer has to be sent as a message.",
    );
    this.name = "DecisionConflictError";
    this.reason = reason;
  }
}

export type WaitingDecisionStore = {
  /** Start waiting, or say it is still waiting. Idempotent; never touches an answer or a close. */
  open(owner: string, input: OpenDecision): Promise<WaitingDecision>;
  /** The tab holding the run is still there. */
  heartbeat(owner: string, toolCallId: string): Promise<WaitingDecision>;
  get(owner: string, toolCallId: string): Promise<WaitingDecision>;
  /** An answer given somewhere else, for the tab holding the run to pick up. */
  answer(
    owner: string,
    toolCallId: string,
    answer: unknown,
  ): Promise<WaitingDecision>;
  /** Done: the run has its answer, or the answer went as a message. Keeps the answer for a reload. */
  close(
    owner: string,
    toolCallId: string,
    answer?: unknown,
  ): Promise<WaitingDecision>;
  /** The cards still waiting on this person, newest first, optionally for one conversation. */
  list(
    owner: string,
    filter?: { channelId?: string },
  ): Promise<WaitingDecision[]>;
};

/** What is kept per card. `ownerUserId` scopes every read and write. */
const storedSchema = openDecisionSchema.extend({
  ownerUserId: z.string().min(1),
  heartbeatAt: z.string().min(1),
  answer: z.unknown().optional(),
  answeredAt: z.string().optional(),
});
type Stored = z.infer<typeof storedSchema>;

function publicDecision(
  stored: Stored,
  row: { createdAt: Date; finished: boolean },
  now: Date,
): WaitingDecision {
  const answer =
    stored.answer === undefined
      ? null
      : (() => {
          try {
            return parseDecisionAnswer(stored.kind, stored.answer);
          } catch {
            return null;
          }
        })();
  return {
    botId: stored.botId,
    channelId: stored.channelId,
    toolCallId: stored.toolCallId,
    kind: stored.kind,
    args: stored.args,
    createdAt: row.createdAt.toISOString(),
    heartbeatAt: stored.heartbeatAt,
    live:
      !row.finished &&
      now.getTime() - new Date(stored.heartbeatAt).getTime() <
        DECISION_STALE_MS,
    answer,
    answeredAt: stored.answeredAt ?? null,
    closed: row.finished,
  };
}

/** Whether an answer may be written now, decided once for both stores. */
function assertAnswerable(decision: WaitingDecision) {
  if (decision.closed || decision.answer !== null)
    throw new DecisionConflictError("answered");
  if (!decision.live) throw new DecisionConflictError("stale");
}

/** One row per person and tool call, so a tool call id somebody else used cannot block yours. */
function keyFor(owner: string, toolCallId: string) {
  return createHash("sha256")
    .update(JSON.stringify([owner, toolCallId]))
    .digest("hex");
}

export function createWaitingDecisionStore(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): WaitingDecisionStore {
  const owned = (owner: string, toolCallId?: string) =>
    and(
      eq(workItems.kind, WAITING_DECISION_KIND),
      sql`${workItems.payload}->>'ownerUserId' = ${owner}`,
      ...(toolCallId ? [eq(workItems.key, keyFor(owner, toolCallId))] : []),
    );
  const read = (row: typeof workItems.$inferSelect | undefined) => {
    if (!row) throw new ApprovalNotFoundError();
    const stored = storedSchema.safeParse(row.payload);
    if (!stored.success) throw new ApprovalNotFoundError();
    return publicDecision(
      stored.data,
      { createdAt: row.createdAt, finished: row.finishedAt !== null },
      now(),
    );
  };
  const get = async (owner: string, toolCallId: string) => {
    const [row] = await database
      .select()
      .from(workItems)
      .where(owned(owner, toolCallId))
      .limit(1);
    return read(row);
  };
  const touch = async (owner: string, toolCallId: string) => {
    const at = now().toISOString();
    await database
      .update(workItems)
      .set({
        payload: sql`jsonb_set(${workItems.payload}, '{heartbeatAt}', to_jsonb(${at}::text))`,
        updatedAt: sql`now()`,
      })
      .where(and(owned(owner, toolCallId), isNull(workItems.finishedAt)));
  };

  return {
    async open(owner, input) {
      const stored: Stored = {
        ...input,
        ownerUserId: owner,
        heartbeatAt: now().toISOString(),
      };
      const inserted = await database
        .insert(workItems)
        .values({
          kind: WAITING_DECISION_KIND,
          key: keyFor(owner, input.toolCallId),
          payload: stored,
        })
        .onConflictDoNothing()
        .returning({ key: workItems.key });
      if (inserted.length === 0) await touch(owner, input.toolCallId);
      return get(owner, input.toolCallId);
    },
    async heartbeat(owner, toolCallId) {
      await touch(owner, toolCallId);
      return get(owner, toolCallId);
    },
    get,
    async answer(owner, toolCallId, answer) {
      return database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(workItems)
          .where(owned(owner, toolCallId))
          .for("update")
          .limit(1);
        const current = read(row);
        const parsed = parseDecisionAnswer(current.kind, answer);
        assertAnswerable(current);
        const at = now().toISOString();
        await tx
          .update(workItems)
          .set({
            payload: sql`${workItems.payload} || ${JSON.stringify({ answer: parsed, answeredAt: at })}::jsonb`,
            updatedAt: sql`now()`,
          })
          .where(owned(owner, toolCallId));
        return { ...current, answer: parsed, answeredAt: at };
      });
    },
    async close(owner, toolCallId, answer) {
      const current = await get(owner, toolCallId);
      const parsed =
        answer === undefined || current.answer !== null
          ? undefined
          : parseDecisionAnswer(current.kind, answer);
      const at = now().toISOString();
      await database
        .update(workItems)
        .set({
          ...(parsed
            ? {
                payload: sql`${workItems.payload} || ${JSON.stringify({ answer: parsed, answeredAt: at })}::jsonb`,
              }
            : {}),
          finishedAt: sql`coalesce(${workItems.finishedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(owned(owner, toolCallId));
      return get(owner, toolCallId);
    },
    async list(owner, filter = {}) {
      const forgotten = new Date(
        now().getTime() - DECISION_FORGOTTEN_MS,
      ).toISOString();
      // Cards nobody has heard from in a long while are closed here, so they do not wait for ever.
      await database
        .update(workItems)
        .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(
          and(
            owned(owner),
            isNull(workItems.finishedAt),
            lt(sql`${workItems.payload}->>'heartbeatAt'`, forgotten),
          ),
        );
      const rows = await database
        .select()
        .from(workItems)
        .where(
          and(
            owned(owner),
            isNull(workItems.finishedAt),
            ...(filter.channelId
              ? [sql`${workItems.payload}->>'channelId' = ${filter.channelId}`]
              : []),
          ),
        )
        .orderBy(desc(workItems.createdAt))
        .limit(50);
      return rows.flatMap((row) => {
        try {
          return [read(row)];
        } catch {
          return [];
        }
      });
    },
  };
}

/**
 * The same store in memory, for tests and for a deployment with no database. Shares every rule with
 * the database store through `publicDecision` and `assertAnswerable`.
 */
export function createMemoryWaitingDecisionStore({
  now = () => new Date(),
}: {
  now?: () => Date;
} = {}): WaitingDecisionStore {
  const rows = new Map<
    string,
    { stored: Stored; createdAt: Date; finished: boolean }
  >();
  const find = (owner: string, toolCallId: string) => {
    const row = rows.get(keyFor(owner, toolCallId));
    if (!row || row.stored.ownerUserId !== owner)
      throw new ApprovalNotFoundError();
    return row;
  };
  const show = (row: { stored: Stored; createdAt: Date; finished: boolean }) =>
    publicDecision(row.stored, row, now());
  const store: WaitingDecisionStore = {
    async open(owner, input) {
      const key = keyFor(owner, input.toolCallId);
      const existing = rows.get(key);
      if (existing) {
        if (!existing.finished)
          existing.stored = {
            ...existing.stored,
            heartbeatAt: now().toISOString(),
          };
        return show(existing);
      }
      const row = {
        stored: {
          ...input,
          ownerUserId: owner,
          heartbeatAt: now().toISOString(),
        },
        createdAt: now(),
        finished: false,
      };
      rows.set(key, row);
      return show(row);
    },
    async heartbeat(owner, toolCallId) {
      const row = find(owner, toolCallId);
      if (!row.finished)
        row.stored = { ...row.stored, heartbeatAt: now().toISOString() };
      return show(row);
    },
    async get(owner, toolCallId) {
      return show(find(owner, toolCallId));
    },
    async answer(owner, toolCallId, answer) {
      const row = find(owner, toolCallId);
      const current = show(row);
      const parsed = parseDecisionAnswer(current.kind, answer);
      assertAnswerable(current);
      row.stored = {
        ...row.stored,
        answer: parsed,
        answeredAt: now().toISOString(),
      };
      return show(row);
    },
    async close(owner, toolCallId, answer) {
      const row = find(owner, toolCallId);
      if (answer !== undefined && row.stored.answer === undefined)
        row.stored = {
          ...row.stored,
          answer: parseDecisionAnswer(row.stored.kind, answer),
          answeredAt: now().toISOString(),
        };
      row.finished = true;
      return show(row);
    },
    async list(owner, filter = {}) {
      const cutoff = now().getTime() - DECISION_FORGOTTEN_MS;
      const open = [];
      for (const row of rows.values()) {
        if (row.stored.ownerUserId !== owner || row.finished) continue;
        if (new Date(row.stored.heartbeatAt).getTime() < cutoff) {
          row.finished = true;
          continue;
        }
        if (filter.channelId && row.stored.channelId !== filter.channelId)
          continue;
        open.push(row);
      }
      return open
        .sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        )
        .map(show);
    },
  };
  return store;
}
