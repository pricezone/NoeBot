import { createHash } from "node:crypto";
import { and, count, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
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
 * questions a Bot asks already use. Read by owner through `work_items_decision_owner_idx` (a partial
 * index on the payload's owner for this kind), kept for a day after it is done with, and capped per
 * person, so nobody can grow the table without limit by opening cards.
 */

export const WAITING_DECISION_KIND = "person.decision";

/** No word from the tab holding the run for this long, and it is taken to be gone. */
export const DECISION_STALE_MS = 15_000;

/** An open card not heard from for this long is no longer offered anywhere, and is closed. */
export const DECISION_FORGOTTEN_MS = 10 * 60_000;

/** How long a card is kept once done with (or abandoned), so a reload still shows its answer. */
export const DECISION_KEPT_MS = 24 * 60 * 60_000;

/** The most cards one person may have waiting at once; a run waits on one at a time. */
export const MAX_OPEN_DECISIONS = 50;

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

/**
 * An answer checked against the card it answers, not only its kind: a picked option must be one of
 * the card's own, under its own label, and a typed answer is the person's words as both its choice
 * and its label (the card always offers a field for one). An approval is approved or declined, with
 * an optional reason. Throws `DecisionAnswerError` for an answer the card could not have given.
 */
export function answerFor(
  card: Pick<OpenDecision, "kind" | "args">,
  answer: unknown,
): DecisionAnswer {
  const parsed = parseDecisionAnswer(card.kind, answer);
  if (card.kind === "approval" || !("choice" in parsed)) return parsed;
  if (parsed.typed) {
    if (parsed.choice !== parsed.label)
      throw new DecisionAnswerError("A typed answer is its own words.");
    return parsed;
  }
  const option = card.args.options?.find((item) => item.id === parsed.choice);
  if (!option || option.label !== parsed.label)
    throw new DecisionAnswerError(
      "That is not one of this question's options.",
    );
  return parsed;
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

/** An answer the card could not have given: an option it does not have, or one mislabelled. */
export class DecisionAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionAnswerError";
  }
}

/** One person has as many cards waiting as anybody could; refused rather than kept growing. */
export class DecisionLimitError extends Error {
  constructor() {
    super(
      "Too many questions are waiting on you at once. Answer or close some first.",
    );
    this.name = "DecisionLimitError";
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
  /** Drop everybody's cards done with, or abandoned, longer than `DECISION_KEPT_MS` ago. */
  purge(): Promise<number>;
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
  /*
   * The kind is written as a literal, not a parameter: the owner index is partial on exactly this
   * kind, and the planner can use it only when the query says so in so many words.
   */
  const ofKind = sql`${workItems.kind} = 'person.decision'`;
  const owned = (owner: string, toolCallId?: string) =>
    and(
      ofKind,
      sql`${workItems.payload}->>'ownerUserId' = ${owner}`,
      ...(toolCallId ? [eq(workItems.key, keyFor(owner, toolCallId))] : []),
    );
  const ago = (ms: number) => new Date(now().getTime() - ms).toISOString();
  const heartbeat = sql`${workItems.payload}->>'heartbeatAt'`;
  const unanswered = sql`(${workItems.payload} -> 'answer') is null`;
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
  const find = async (owner: string, toolCallId: string) => {
    const [row] = await database
      .select()
      .from(workItems)
      .where(owned(owner, toolCallId))
      .limit(1);
    return row;
  };
  const get = async (owner: string, toolCallId: string) =>
    read(await find(owner, toolCallId));
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
  /** This person's own: forgotten cards closed, and cards done with a day ago gone. */
  const tidy = async (owner: string) => {
    await database
      .update(workItems)
      .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          owned(owner),
          isNull(workItems.finishedAt),
          lt(heartbeat, ago(DECISION_FORGOTTEN_MS)),
        ),
      );
    await database
      .delete(workItems)
      .where(
        and(
          owned(owner),
          lt(workItems.finishedAt, new Date(ago(DECISION_KEPT_MS))),
        ),
      );
  };
  /*
   * The object itself, not its JSON text: the driver encodes an object for a `jsonb` parameter, and
   * a string handed to it is stored as a JSON string, which `||` then appends as an array element.
   */
  const answerPatch = (answer: DecisionAnswer) =>
    sql`${{ answer, answeredAt: now().toISOString() }}::jsonb`;

  return {
    async open(owner, input) {
      if (await find(owner, input.toolCallId)) {
        await touch(owner, input.toolCallId);
        return get(owner, input.toolCallId);
      }
      await tidy(owner);
      const [waiting] = await database
        .select({ value: count() })
        .from(workItems)
        .where(and(owned(owner), isNull(workItems.finishedAt)));
      if ((waiting?.value ?? 0) >= MAX_OPEN_DECISIONS)
        throw new DecisionLimitError();
      const stored: Stored = {
        ...input,
        ownerUserId: owner,
        heartbeatAt: now().toISOString(),
      };
      await database
        .insert(workItems)
        .values({
          kind: WAITING_DECISION_KIND,
          key: keyFor(owner, input.toolCallId),
          payload: stored,
        })
        .onConflictDoNothing();
      return get(owner, input.toolCallId);
    },
    async heartbeat(owner, toolCallId) {
      await touch(owner, toolCallId);
      return get(owner, toolCallId);
    },
    get,
    async answer(owner, toolCallId, answer) {
      const current = await get(owner, toolCallId);
      const parsed = answerFor(current, answer);
      /*
       * ONE CONDITIONAL WRITE: still open, still unanswered, and heard from in the last fifteen
       * seconds. A close or another answer landing between the read above and this write makes it
       * match nothing, and the row is read again to say which.
       */
      const [row] = await database
        .update(workItems)
        .set({
          payload: sql`${workItems.payload} || ${answerPatch(parsed)}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            owned(owner, toolCallId),
            isNull(workItems.finishedAt),
            unanswered,
            gte(heartbeat, ago(DECISION_STALE_MS)),
          ),
        )
        .returning();
      if (row) return read(row);
      assertAnswerable(await get(owner, toolCallId));
      throw new DecisionConflictError("answered");
    },
    async close(owner, toolCallId, answer) {
      const current = await get(owner, toolCallId);
      const parsed =
        answer === undefined || current.answer !== null
          ? undefined
          : answerFor(current, answer);
      // One write: an answer that raced in first is kept, never overwritten by this one.
      const [row] = await database
        .update(workItems)
        .set({
          ...(parsed
            ? {
                payload: sql`case when ${unanswered} then ${workItems.payload} || ${answerPatch(parsed)} else ${workItems.payload} end`,
              }
            : {}),
          finishedAt: sql`coalesce(${workItems.finishedAt}, now())`,
          updatedAt: sql`now()`,
        })
        .where(owned(owner, toolCallId))
        .returning();
      return read(row);
    },
    async list(owner, filter = {}) {
      const rows = await database
        .select()
        .from(workItems)
        .where(
          and(
            owned(owner),
            isNull(workItems.finishedAt),
            gte(heartbeat, ago(DECISION_FORGOTTEN_MS)),
            ...(filter.channelId
              ? [sql`${workItems.payload}->>'channelId' = ${filter.channelId}`]
              : []),
          ),
        )
        .orderBy(desc(workItems.createdAt))
        .limit(MAX_OPEN_DECISIONS);
      return rows.flatMap((row) => {
        try {
          return [read(row)];
        } catch {
          return [];
        }
      });
    },
    async purge() {
      const cutoff = ago(DECISION_KEPT_MS);
      const gone = await database
        .delete(workItems)
        .where(
          and(
            ofKind,
            or(
              lt(workItems.finishedAt, new Date(cutoff)),
              and(isNull(workItems.finishedAt), lt(heartbeat, cutoff)),
            ),
          ),
        )
        .returning({ key: workItems.key });
      return gone.length;
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
  type Row = {
    stored: Stored;
    createdAt: Date;
    finished: boolean;
    finishedAt?: number;
  };
  const rows = new Map<string, Row>();
  const finish = (row: Row) => {
    if (row.finished) return;
    row.finished = true;
    row.finishedAt = now().getTime();
  };
  const find = (owner: string, toolCallId: string) => {
    const row = rows.get(keyFor(owner, toolCallId));
    if (!row || row.stored.ownerUserId !== owner)
      throw new ApprovalNotFoundError();
    return row;
  };
  const show = (row: { stored: Stored; createdAt: Date; finished: boolean }) =>
    publicDecision(row.stored, row, now());
  const heard = (row: { stored: Stored }) =>
    new Date(row.stored.heartbeatAt).getTime();
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
      const forgotten = now().getTime() - DECISION_FORGOTTEN_MS;
      let waiting = 0;
      for (const other of rows.values()) {
        if (other.stored.ownerUserId !== owner || other.finished) continue;
        if (heard(other) < forgotten) finish(other);
        else waiting += 1;
      }
      if (waiting >= MAX_OPEN_DECISIONS) throw new DecisionLimitError();
      const row: Row = {
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
      const parsed = answerFor(current, answer);
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
          answer: answerFor(row.stored, answer),
          answeredAt: now().toISOString(),
        };
      finish(row);
      return show(row);
    },
    async list(owner, filter = {}) {
      const cutoff = now().getTime() - DECISION_FORGOTTEN_MS;
      const open = [];
      for (const row of rows.values()) {
        if (row.stored.ownerUserId !== owner || row.finished) continue;
        if (heard(row) < cutoff) continue;
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
    async purge() {
      const cutoff = now().getTime() - DECISION_KEPT_MS;
      let gone = 0;
      for (const [key, row] of rows) {
        const done = row.finished ? (row.finishedAt ?? 0) : heard(row);
        if (done >= cutoff) continue;
        rows.delete(key);
        gone += 1;
      }
      return gone;
    },
  };
  return store;
}
