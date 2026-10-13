import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { runToolCalls, users } from "../src/db/schema";
import { createToolCallLedger } from "../src/runs/ledger";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The ledger against Postgres: the same verdicts as in memory, and one winner when two replicas
 * race to use one call. Skipped without TEST_DATABASE_URL.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL?.trim());
const database = enabled
  ? createDatabase(testDatabaseUrl(), TEST_POOL)
  : undefined;
const ownerUserId = `ledger-owner-${crypto.randomUUID()}`;
const call = {
  threadId: `thread-${crypto.randomUUID()}`,
  toolCallId: "click-1",
  ownerUserId,
  botId: "bot",
  toolName: "computer_click",
  args: { ref: "e7", snapshotId: 3 },
};

describe.skipIf(!enabled)("the saved-call ledger in Postgres", () => {
  const db = () => {
    if (!database) throw new Error("TEST_DATABASE_URL is not set.");
    return database;
  };
  afterEach(async () => {
    await db()
      .delete(runToolCalls)
      .where(eq(runToolCalls.ownerUserId, ownerUserId));
  });
  afterAll(async () => {
    await db().delete(users).where(eq(users.id, ownerUserId));
  });

  test("records, passes once, and refuses a replay from another replica", async () => {
    await db()
      .insert(users)
      .values({ id: ownerUserId, email: `${ownerUserId}@example.com` })
      .onConflictDoNothing();
    await createToolCallLedger(db()).record(call);
    const [first, second] = await Promise.all([
      createToolCallLedger(db()).consume(call),
      createToolCallLedger(db()).consume(call),
    ]);
    expect([first, second].sort()).toEqual(["ok", "replayed"]);
  });

  test("refuses other arguments and answers missing for a call never made", async () => {
    await db()
      .insert(users)
      .values({ id: ownerUserId, email: `${ownerUserId}@example.com` })
      .onConflictDoNothing();
    const ledger = createToolCallLedger(db());
    await ledger.record(call);
    await expect(
      ledger.consume({ ...call, args: { ref: "e8", snapshotId: 3 } }),
    ).resolves.toBe("mismatch");
    await expect(
      ledger.consume({ ...call, toolCallId: "never" }),
    ).resolves.toBe("missing");
    expect(await ledger.purge(new Date(Date.now() + 60_000))).toBeGreaterThan(
      0,
    );
  });
});
