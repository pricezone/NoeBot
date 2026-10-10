import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  createApprovalQuestions,
  type PersonQuestion,
} from "../src/approvals/questions";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A question answered in the conversation it was asked in leaves the Approvals inbox, with the
 * answer recorded beside it and nothing queued to resume the conversation again: the person's
 * message there already started its own turn.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `conversation-answer-${randomUUID()}`;
const owner = `${prefix}-owner`;
const questions = createApprovalQuestions(database, async () => undefined);
const keys: string[] = [];
const thread = `${prefix}-thread`;
const ASKED = "What do you mainly want help with?";

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
});
afterAll(async () => {
  if (keys.length)
    await database
      .delete(workItems)
      .where(
        and(
          inArray(workItems.kind, ["person.question", "person.response"]),
          inArray(workItems.key, keys),
        ),
      );
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

async function save(over: Partial<PersonQuestion> = {}) {
  const key = randomUUID();
  keys.push(key);
  const payload: PersonQuestion = {
    actorId: owner,
    botId: "new-bot",
    threadId: thread,
    runId: randomUUID(),
    question: ASKED,
    mode: "completed_question",
    initiator: { kind: "person" },
    ...over,
  };
  await database
    .insert(workItems)
    .values({ kind: "person.question", key, payload });
  return key;
}

const open = async () => (await questions.list(owner)).map((entry) => entry.id);

test("answered in the conversation, the question leaves the inbox with its answer recorded and nothing queued", async () => {
  const key = await save();
  const elsewhere = await save({ threadId: `${prefix}-other-thread` });
  const different = await save({ question: "Which account?" });

  const result = await questions.answerInConversation(owner, {
    threadId: thread,
    questions: [ASKED],
    response: "Research and writing",
  });

  expect(result.resolved).toEqual([key]);
  const still = await open();
  expect(still).not.toContain(key);
  expect(still).toContain(elsewhere);
  expect(still).toContain(different);
  const [response] = await database
    .select()
    .from(workItems)
    .where(and(eq(workItems.kind, "person.response"), eq(workItems.key, key)));
  expect(response?.payload).toMatchObject({
    ownerUserId: owner,
    response: "Research and writing",
    answeredIn: "conversation",
  });
  // Finished as it is written, so the sweep that resumes answers never claims it.
  expect(response?.finishedAt).not.toBeNull();
});

test("a responsibility's question stays for the inbox, whose answer resumes its run", async () => {
  const key = await save({
    initiator: { kind: "responsibility", id: `${prefix}-goal` },
  });

  const result = await questions.answerInConversation(owner, {
    threadId: thread,
    questions: [ASKED],
    response: "Ramen, please.",
  });

  expect(result.resolved).not.toContain(key);
  expect(await open()).toContain(key);
});

test("answering again in the conversation is a no-op, and the inbox says it was answered", async () => {
  const key = await save();
  await questions.answerInConversation(owner, {
    threadId: thread,
    questions: [ASKED],
    response: "Web tasks and errands",
  });

  const again = await questions.answerInConversation(owner, {
    threadId: thread,
    questions: [ASKED],
    response: "Web tasks and errands",
  });

  expect(again.resolved).not.toContain(key);
  await expect(questions.respond(owner, key, "Something else")).rejects.toThrow(
    "You already answered this question.",
  );
});

test("nobody closes somebody else's question", async () => {
  const key = await save();

  const result = await questions.answerInConversation(`${prefix}-intruder`, {
    threadId: thread,
    questions: [ASKED],
    response: "Mine now",
  });

  expect(result.resolved).toEqual([]);
  expect(await open()).toContain(key);
});
