import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ClickyServerEvent } from "../../shared/clicky";
import { reduceClicky } from "../../shared/clicky-state";
import {
  createClickyHub,
  notifyClickyActivity,
  startClickyActivityListener,
} from "../src/clicky/hub";
import { createClickyStore } from "../src/clicky/store";
import { createDatabase } from "../src/db/client";
import { agents, clickySessions, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * Clicky's sessions in Postgres: one open session per person and Bot, written compare-and-set on
 * `seq`, put away after the resume window, and every change heard by every replica's listener.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const userId = `clicky-user-${randomUUID()}`;
const botId = `clicky-bot-${randomUUID()}`;

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test` });
  await database.insert(agents).values({
    id: botId,
    name: "Clicky test",
    type: "built_in",
    configuration: {},
  });
});

afterAll(async () => {
  await database.delete(users).where(eq(users.id, userId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.end({ timeout: 5 });
});

const wake = { type: "command", command: { type: "wake" } } as const;
const context = () => ({
  now: Date.now(),
  actionPolicy: "ask_each" as const,
  newId: randomUUID,
});

describe("createClickyStore", () => {
  test("one open session, written only over the seq it was read at", async () => {
    const store = createClickyStore(database);
    const now = Date.now();
    const first = await store.open(userId, botId, now);
    expect(first.created).toBe(true);
    const again = await store.open(userId, botId, now);
    expect(again).toEqual({ session: first.session, created: false });

    const woken = reduceClicky(first.session, wake, context()).session;
    expect(await store.save(userId, botId, woken, 0)).toBe(true);
    // A second writer that read seq 0 too loses.
    const paused = reduceClicky(
      first.session,
      { type: "command", command: { type: "pause" } },
      context(),
    ).session;
    expect(await store.save(userId, botId, paused, 0)).toBe(false);
    const stored = await store.load(userId, botId);
    expect(stored?.seq).toBe(1);
    expect(stored?.awake).toBe(true);
    const [row] = await database
      .select({ seq: clickySessions.seq })
      .from(clickySessions)
      .where(eq(clickySessions.id, first.session.id));
    expect(row?.seq).toBe(1);
  });

  test("a session left past the resume window is put away and a fresh one opened", async () => {
    const store = createClickyStore(database);
    const current = await store.open(userId, botId, Date.now());
    const later = Date.parse(current.session.updatedAt) + 31 * 60_000;
    const fresh = await store.open(userId, botId, later);
    expect(fresh.created).toBe(true);
    expect(fresh.session.id).not.toBe(current.session.id);
    expect(fresh.session.awake).toBe(false);
    const [ended] = await database
      .select({ endedAt: clickySessions.endedAt })
      .from(clickySessions)
      .where(eq(clickySessions.id, current.session.id));
    expect(ended?.endedAt).not.toBeNull();
    // A put-away session cannot be written to.
    const late = reduceClicky(current.session, wake, context()).session;
    expect(await store.save(userId, botId, late, current.session.seq)).toBe(
      false,
    );
  });
});

describe("the activity listener", () => {
  test("a change announced through Postgres reaches this replica's sockets", async () => {
    const store = createClickyStore(database);
    const hub = createClickyHub({ load: (u, b) => store.load(u, b) });
    const listener = await startClickyActivityListener(testDatabaseUrl(), hub);
    try {
      const seen: ClickyServerEvent[] = [];
      hub.subscribe(userId, botId, (event) => seen.push(event));
      // Another replica writes and announces; this hub delivered nothing itself.
      const current = (await store.open(userId, botId, Date.now())).session;
      const next = reduceClicky(
        current,
        { type: "command", command: { type: "pause" } },
        context(),
      ).session;
      expect(await store.save(userId, botId, next, current.seq)).toBe(true);
      await notifyClickyActivity(database)({
        userId,
        botId,
        seq: next.seq,
      });
      const deadline = Date.now() + 3000;
      while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(seen).toEqual([{ type: "snapshot", session: next }]);
    } finally {
      await listener.stop();
    }
  });
});
