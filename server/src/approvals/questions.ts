import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { workItems } from "../db/schema/work";
import { ApprovalNotFoundError, ApprovalRefusedError } from "./types";

const questionSchema = z.object({
  actorId: z.string().min(1),
  botId: z.string().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
  question: z.string().min(1).max(6000),
  why: z.string().max(6000).optional(),
  mode: z.literal("completed_question"),
  sourceBotId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  /**
   * What started the run that asked. Kept so the answer resumes that run's work as the same kind of
   * turn: a responsibility's question comes back to the responsibility, with its tools.
   */
  initiator: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("person") }),
      z.object({ kind: z.literal("deployment") }),
      z.object({ kind: z.literal("routine"), id: z.string().min(1) }),
      z.object({ kind: z.literal("responsibility"), id: z.string().min(1) }),
      z.object({ kind: z.literal("memory"), id: z.string().min(1) }),
      z.object({ kind: z.literal("handoff"), id: z.string().min(1) }),
    ])
    .optional(),
});
export const personQuestionSchema = questionSchema;
export type PersonQuestion = z.infer<typeof questionSchema>;
export const questionConversationBot = (question: PersonQuestion) =>
  question.sourceBotId ?? question.botId;
export const questionResponseMessage = (
  question: PersonQuestion,
  response: string,
  id: string,
) => ({
  id,
  role: "user" as const,
  content: `In response to your question: ${question.question}\n\n${response}`,
});
export type ApprovalQuestions = ReturnType<typeof createApprovalQuestions>;

/** What the person said in a conversation, in reply to the questions open there when they said it. */
export type ConversationAnswer = {
  /** The conversation's thread, which is the thread the question was asked in. */
  threadId: string;
  /** The questions as the Bot asked them; matched on their words, since that is all the screen has. */
  questions: readonly string[];
  /** What the person said: the option they picked, or their own words. */
  response: string;
};

/**
 * Whether a saved question is one the person just answered in the conversation it was asked in.
 *
 * Same thread and the same words. NOT a responsibility's question: that one holds its run suspended,
 * and only an answer that resumes the run (the Approvals inbox's) lets the responsibility record its
 * progress; closed from here it would wait for ever. Pure, so the rule is testable without a
 * database.
 */
export function answeredInConversation(
  question: PersonQuestion,
  answer: Pick<ConversationAnswer, "threadId" | "questions">,
): boolean {
  if (question.threadId !== answer.threadId) return false;
  if (question.initiator?.kind === "responsibility") return false;
  const asked = question.question.trim();
  return answer.questions.some((candidate) => candidate.trim() === asked);
}

export function createApprovalQuestions(
  database: Database,
  authorise: (question: PersonQuestion) => Promise<void>,
) {
  const owned = (owner: string, key?: string) =>
    and(
      eq(workItems.kind, "person.question"),
      sql`${workItems.payload}->>'actorId' = ${owner}`,
      ...(key ? [eq(workItems.key, key)] : []),
    );
  /**
   * Answer a saved question: the one path the Approvals inbox and a conversation share, so both
   * check the same things, close the question the same way and record the answer in the same row.
   *
   * `resume: false` is for an answer the person already gave in the conversation. Their message
   * started its own turn there, so the answer is recorded as already handled rather than queued to
   * resume the conversation a second time, and a question answered before is not an error.
   */
  const respond = async (
    owner: string,
    id: string,
    response: string,
    { resume = true }: { resume?: boolean } = {},
  ) => {
    const answer = z.string().trim().min(1).max(6000).parse(response);
    const [current] = await database
      .select()
      .from(workItems)
      .where(owned(owner, id))
      .limit(1);
    if (!current) throw new ApprovalNotFoundError();
    const parsed = questionSchema.safeParse(current.payload);
    if (!parsed.success)
      throw new ApprovalRefusedError(
        "This question has no completed conversation to continue.",
      );
    await authorise(parsed.data);
    return database.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(workItems)
        .where(owned(owner, id))
        .for("update")
        .limit(1);
      if (!row) throw new ApprovalNotFoundError();
      if (row.finishedAt) {
        if (!resume) return { id, queued: false };
        throw new ApprovalRefusedError("You already answered this question.");
      }
      await tx
        .insert(workItems)
        .values({
          kind: "person.response",
          key: id,
          payload: {
            ownerUserId: owner,
            question: parsed.data,
            response: answer,
            ...(resume ? {} : { answeredIn: "conversation" }),
          },
          // Already handled: the sweep claims only unfinished rows, so this one is never resumed.
          ...(resume ? {} : { finishedAt: sql`now()` }),
        })
        .onConflictDoNothing();
      await tx
        .update(workItems)
        .set({ finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(owned(owner, id));
      if (resume)
        await tx.execute(
          sql`select pg_notify('openbot_work_offered', 'person.response')`,
        );
      return { id, queued: resume };
    });
  };

  return {
    async list(owner: string) {
      const rows = await database
        .select()
        .from(workItems)
        .where(and(owned(owner), isNull(workItems.finishedAt)))
        .orderBy(desc(workItems.createdAt))
        .limit(100);
      return rows
        .map((row) => {
          const value = questionSchema.safeParse(row.payload);
          return value.success
            ? {
                id: row.key,
                botId: value.data.botId,
                threadId: value.data.threadId,
                question: value.data.question,
                why: value.data.why,
                createdAt: row.createdAt,
              }
            : null;
        })
        .filter((row) => row !== null);
    },
    /** An answer given in the Approvals inbox: the conversation is resumed with it. */
    respond: (owner: string, id: string, response: string) =>
      respond(owner, id, response),
    /**
     * An answer given in the conversation itself — an option picked on the question's card, or
     * words typed there. Every open question it answers is closed with that answer recorded, so the
     * inbox and the Bot's Activity stop listing it as waiting. Answers which questions it closed.
     */
    async answerInConversation(owner: string, input: ConversationAnswer) {
      const rows = await database
        .select()
        .from(workItems)
        .where(
          and(
            owned(owner),
            isNull(workItems.finishedAt),
            sql`${workItems.payload}->>'threadId' = ${input.threadId}`,
          ),
        )
        .limit(100);
      const resolved: string[] = [];
      for (const row of rows) {
        const parsed = questionSchema.safeParse(row.payload);
        if (!parsed.success || !answeredInConversation(parsed.data, input))
          continue;
        try {
          await respond(owner, row.key, input.response, { resume: false });
          resolved.push(row.key);
        } catch (error) {
          // One that can no longer be answered here stays where the inbox can show why.
          if (
            error instanceof ApprovalNotFoundError ||
            error instanceof ApprovalRefusedError
          )
            continue;
          throw error;
        }
      }
      return { resolved };
    },
  };
}
