import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  createWaitingDecisionStore,
  DECISION_KEPT_MS,
  DECISION_STALE_MS,
  DecisionAnswerError,
  DecisionConflictError,
  DecisionLimitError,
  MAX_OPEN_DECISIONS,
  WAITING_DECISION_KIND,
} from "../src/approvals/decisions";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema/work";

/**
 * The database store behind the waiting decision cards: one row per person and tool call in
 * `work_items`, under a kind nothing claims. Skipped without TEST_DATABASE_URL, like every other
 * suite that needs a database; the rules themselves are covered in memory by
 * approvals-waiting-decisions.test.ts.
 */

const hasDatabase = Boolean(process.env.TEST_DATABASE_URL?.trim());

describe.skipIf(!hasDatabase)("waiting decisions in the database", () => {
  const prefix = `waiting-decision-${randomUUID()}`;
  const owner = `${prefix}-owner`;
  let clock = new Date();
  const open = async () => {
    const { testDatabaseUrl, TEST_POOL } = await import("./support/database");
    return createDatabase(testDatabaseUrl(), TEST_POOL);
  };
  let database: Awaited<ReturnType<typeof open>> | undefined;

  afterAll(async () => {
    if (!database) return;
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, WAITING_DECISION_KIND),
          sql`${workItems.payload}->>'ownerUserId' = ${owner}`,
        ),
      );
    await database.$client.close();
  });

  test("open, heartbeat, answer, close, scoped to the owner", async () => {
    database ??= await open();
    const store = createWaitingDecisionStore(database, { now: () => clock });
    const input = {
      botId: "assistant",
      channelId: `${prefix}-channel`,
      toolCallId: `${prefix}-call`,
      kind: "approval" as const,
      args: { title: "Refund this order?" },
    };
    expect((await store.open(owner, input)).live).toBe(true);
    // Idempotent: a second open is a heartbeat, not a second row.
    await store.open(owner, input);
    expect(
      await store.list(owner, { channelId: input.channelId }),
    ).toHaveLength(1);
    await expect(
      store.get(`${prefix}-intruder`, input.toolCallId),
    ).rejects.toThrow();

    clock = new Date(clock.getTime() + DECISION_STALE_MS + 1);
    await expect(
      store.answer(owner, input.toolCallId, { decision: "approved" }),
    ).rejects.toBeInstanceOf(DecisionConflictError);
    await store.heartbeat(owner, input.toolCallId);
    const answered = await store.answer(owner, input.toolCallId, {
      decision: "approved",
    });
    expect(answered.answer).toEqual({ decision: "approved" });
    const closed = await store.close(owner, input.toolCallId);
    expect(closed).toMatchObject({
      closed: true,
      answer: { decision: "approved" },
    });
    expect(await store.list(owner)).toEqual([]);
  });

  test("a choice answer must be one of the card's options, and a close keeps an answer that got there first", async () => {
    database ??= await open();
    const store = createWaitingDecisionStore(database, { now: () => clock });
    const input = {
      botId: "assistant",
      channelId: `${prefix}-channel`,
      toolCallId: `${prefix}-choice`,
      kind: "choice" as const,
      args: {
        title: "Which environment?",
        options: [
          { id: "staging", label: "Staging" },
          { id: "production", label: "Production" },
        ],
      },
    };
    await store.open(owner, input);
    await expect(
      store.answer(owner, input.toolCallId, { choice: "qa", label: "QA" }),
    ).rejects.toBeInstanceOf(DecisionAnswerError);
    await store.answer(owner, input.toolCallId, {
      choice: "staging",
      label: "Staging",
    });
    const closed = await store.close(owner, input.toolCallId, {
      choice: "production",
      label: "Production",
    });
    expect(closed).toMatchObject({
      closed: true,
      answer: { choice: "staging", label: "Staging" },
    });
    await expect(
      store.answer(owner, input.toolCallId, {
        choice: "production",
        label: "Production",
      }),
    ).rejects.toBeInstanceOf(DecisionConflictError);
  });

  test("a person's open cards are capped, and the sweep drops what is a day old", async () => {
    database ??= await open();
    const capped = `${owner}-capped`;
    const store = createWaitingDecisionStore(database, { now: () => clock });
    const card = (index: number) => ({
      botId: "assistant",
      channelId: `${prefix}-channel`,
      toolCallId: `${prefix}-cap-${index}`,
      kind: "approval" as const,
      args: { title: "Refund?" },
    });
    for (let index = 0; index < MAX_OPEN_DECISIONS; index += 1)
      await store.open(capped, card(index));
    await expect(
      store.open(capped, card(MAX_OPEN_DECISIONS)),
    ).rejects.toBeInstanceOf(DecisionLimitError);
    expect(await store.list(capped)).toHaveLength(MAX_OPEN_DECISIONS);

    clock = new Date(clock.getTime() + DECISION_KEPT_MS + 1);
    expect(await store.purge()).toBeGreaterThanOrEqual(MAX_OPEN_DECISIONS);
    await expect(store.get(capped, card(0).toolCallId)).rejects.toThrow();
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, WAITING_DECISION_KIND),
          sql`${workItems.payload}->>'ownerUserId' = ${capped}`,
        ),
      );
  });
});
