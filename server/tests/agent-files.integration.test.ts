import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import {
  type AgentFilesCursor,
  channelAttachmentFiles,
  newestFirst,
} from "../src/agents/files";
import { createDatabase } from "../src/db/client";
import {
  agents,
  attachments,
  channelAgents,
  channelMemberships,
  channels,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The attachments half of a Bot's Library, against a real PostgreSQL.
 *
 * What it must list is exactly what `GET /api/attachments/:id` would serve this person, in this
 * Bot's channels: so every row the query must leave out sits beside one it must keep — another
 * Bot's channel, a channel the person is not in, a deleted channel, a staged draft — and two rows
 * share a microsecond, which is the tie a millisecond cursor would lose.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `agent-files-${randomUUID()}`;
const owner = `${prefix}-owner`;
const colleague = `${prefix}-colleague`;
const bot = `${prefix}-bot`;
const otherBot = `${prefix}-other-bot`;
const direct = `${prefix}-direct`;
const shared = `${prefix}-shared`;
const notMine = `${prefix}-not-mine`;
const deleted = `${prefix}-deleted`;
const otherBots = `${prefix}-other-bots`;

/** Name → id of every attachment inserted, so the assertions read as names. */
const ids = new Map<string, string>();

async function attach(
  name: string,
  channelId: string,
  uploadedBy: string,
  createdAt: string,
  { mimeType = "text/plain", sent = true } = {},
) {
  const [row] = await database
    .insert(attachments)
    .values({
      channelId,
      uploadedBy,
      name,
      mimeType,
      sizeBytes: 3,
      bytes: Buffer.from("abc"),
      attachedAt: sent ? new Date() : null,
    })
    .returning({ id: attachments.id });
  if (!row) throw new Error(`Could not insert ${name}.`);
  // Set to the microsecond in SQL, because a `Date` cannot carry the ties this test is about.
  await database.execute(
    sql`update attachments set created_at = ${createdAt}::timestamptz where id = ${row.id}::uuid`,
  );
  ids.set(name, row.id);
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: colleague, email: `${colleague}@example.test` },
  ]);
  await database.insert(agents).values([
    { id: bot, name: "Files Bot", type: "built_in", configuration: {} },
    { id: otherBot, name: "Other Bot", type: "built_in", configuration: {} },
  ]);
  await database.insert(channels).values(
    [direct, shared, notMine, deleted, otherBots].map((id) => ({
      id,
      name: id,
      description: "",
      ...(id === deleted ? { deletedAt: new Date() } : {}),
    })),
  );
  await database.insert(channelMemberships).values([
    { channelId: direct, userId: owner },
    { channelId: shared, userId: owner },
    { channelId: shared, userId: colleague },
    { channelId: notMine, userId: colleague },
    { channelId: deleted, userId: owner },
    { channelId: otherBots, userId: owner },
  ]);
  await database.insert(channelAgents).values([
    { channelId: direct, agentId: bot },
    { channelId: shared, agentId: bot },
    { channelId: notMine, agentId: bot },
    { channelId: deleted, agentId: bot },
    { channelId: otherBots, agentId: otherBot },
  ]);

  await attach("oldest.txt", direct, owner, "2026-09-01T10:00:00.000001Z");
  await attach("photo.png", direct, owner, "2026-10-10T09:00:00.123456Z", {
    mimeType: "image/png",
  });
  await attach(
    "colleague.csv",
    shared,
    colleague,
    "2026-10-10T09:00:00.123456Z",
  );
  await attach("newest.txt", shared, owner, "2026-10-10T11:00:00.000000Z");
  // Each of these is left out for a different reason.
  await attach("draft.txt", direct, owner, "2026-10-10T12:00:00.000000Z", {
    sent: false,
  });
  await attach(
    "not-mine.txt",
    notMine,
    colleague,
    "2026-10-10T12:00:00.000000Z",
  );
  await attach("deleted.txt", deleted, owner, "2026-10-10T12:00:00.000000Z");
  await attach(
    "other-bot.txt",
    otherBots,
    owner,
    "2026-10-10T12:00:00.000000Z",
  );
});

afterAll(async () => {
  await database
    .delete(channels)
    .where(inArray(channels.id, [direct, shared, notMine, deleted, otherBots]));
  await database.delete(agents).where(inArray(agents.id, [bot, otherBot]));
  await database.delete(users).where(inArray(users.id, [owner, colleague]));
  await database.$client.close();
});

const list = channelAttachmentFiles(database);

/** The two ids that share a microsecond, in the order the list breaks the tie: uuid descending. */
function tiedInOrder(): string[] {
  return ["photo.png", "colleague.csv"].sort((a, b) =>
    (ids.get(a) ?? "") < (ids.get(b) ?? "") ? 1 : -1,
  );
}

describe("a Bot's attachments", () => {
  test("are the sent files in its channels that this person is in, whoever sent them", async () => {
    const rows = await list({ actorId: owner, agentId: bot, limit: 50 });
    expect(rows.map((row) => row.file.name)).toEqual([
      "newest.txt",
      ...tiedInOrder(),
      "oldest.txt",
    ]);
    // Already in the merged order, which the merge relies on.
    expect([...rows].sort(newestFirst)).toEqual(rows);
  });

  test("carry the microsecond they were attached at, and a picture only for an image", async () => {
    const rows = await list({ actorId: owner, agentId: bot, limit: 50 });
    const photo = rows.find((row) => row.file.name === "photo.png");
    const id = ids.get("photo.png");
    expect(photo).toEqual({
      sortAt: "2026-10-10T09:00:00.123456Z",
      file: {
        id: `attachment:${id}`,
        name: "photo.png",
        source: "attachment",
        mimeType: "image/png",
        sizeBytes: 3,
        at: "2026-10-10T09:00:00.123Z",
        url: `/api/attachments/${id}`,
        thumbnailUrl: `/api/attachments/${id}`,
      },
    });
    const text = rows.find((row) => row.file.name === "oldest.txt");
    expect(text?.file.thumbnailUrl).toBeNull();
  });

  test("are read one past the page, and a cursor inside a tie keeps the other half of it", async () => {
    const first = await list({ actorId: owner, agentId: bot, limit: 2 });
    // Two asked for, three back: the third says there is more.
    expect(first.map((row) => row.file.name)).toEqual([
      "newest.txt",
      ...tiedInOrder().slice(0, 2),
    ]);

    const tied = first[1];
    if (!tied) throw new Error("Expected a second row.");
    const after: AgentFilesCursor = { at: tied.sortAt, id: tied.file.id };
    const next = await list({ actorId: owner, agentId: bot, after, limit: 2 });
    expect(next.map((row) => row.file.name)).toEqual([
      tiedInOrder()[1],
      "oldest.txt",
    ]);
  });

  test("after a workspace file at the same microsecond, every attachment at that moment follows", async () => {
    const after: AgentFilesCursor = {
      at: "2026-10-10T09:00:00.123456Z",
      id: "workspace:report.csv",
    };
    const rows = await list({ actorId: owner, agentId: bot, after, limit: 50 });
    expect(rows.map((row) => row.file.name)).toEqual([
      ...tiedInOrder(),
      "oldest.txt",
    ]);
  });

  test("are only ever from channels the asker is in, and only for the Bot asked about", async () => {
    const rows = await list({ actorId: colleague, agentId: bot, limit: 50 });
    expect(rows.map((row) => row.file.name).sort()).toEqual(
      ["colleague.csv", "newest.txt", "not-mine.txt"].sort(),
    );
    const none = await list({ actorId: owner, agentId: otherBot, limit: 50 });
    expect(none.map((row) => row.file.name)).toEqual(["other-bot.txt"]);
    expect(
      await database
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.channelId, deleted)),
    ).toHaveLength(1);
  });
});
