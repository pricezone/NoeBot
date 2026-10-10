import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import {
  ChannelNotFoundError,
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import {
  SectionNotFoundError,
  SectionOrderError,
} from "../src/channels/sections";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelMemberships,
  channelSections,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The sidebar's own organisation of a person's conversations: sections, the unread marker moved
 * back, and hiding. All three are one person's and nobody else's, so most tests here are about a
 * channel with two members and what the second one does or does not see.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);

const testPrefix = `channel-sidebar-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  // Sections go with their person, by cascade.
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Sidebar Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name = "Expense Manager") {
  const profile = await profileStore.create(owner, {
    name,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "public",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const channel = await store.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return channel;
}

/** A channel with a second member, given a membership and a thread mapping of their own. */
async function sharedChannel() {
  const owner = await createUser();
  const other = await createUser();
  const agentId = await createAgent(owner);
  const channel = await createChannel(owner, [agentId]);
  await database
    .insert(channelMemberships)
    .values({ channelId: channel.id, userId: other.id });
  await database.insert(intelligenceChannelMappings).values({
    userId: other.id,
    channelId: channel.id,
    threadId: randomUUID(),
  });
  return { owner, other, agentId, channelId: channel.id };
}

async function rosterRow(actor: AgentActor, channelId: string) {
  const page = await store.list(actor);
  const row = page.channels.find((channel) => channel.id === channelId);
  if (!row) throw new Error(`${channelId} is not on the roster`);
  return row;
}

/** The comparison the browser makes, on the strings it is sent. */
const iso = (date: Date | null) => date?.toISOString() ?? null;

describe("sidebar sections", () => {
  test("are created after the last one and listed in that order", async () => {
    const owner = await createUser();

    const work = await store.createSection(owner, "Work");
    const home = await store.createSection(owner, "Home");

    expect(work.position).toBe(0);
    expect(home.position).toBe(1);
    expect(await store.listSections(owner)).toEqual([work, home]);
  });

  test("are one person's: another person lists none and cannot rename or delete them", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const work = await store.createSection(owner, "Work");

    expect(await store.listSections(stranger)).toEqual([]);
    await expect(
      store.renameSection(stranger, work.id, "Mine now"),
    ).rejects.toBeInstanceOf(SectionNotFoundError);
    await expect(store.deleteSection(stranger, work.id)).rejects.toBeInstanceOf(
      SectionNotFoundError,
    );
    expect(await store.listSections(owner)).toEqual([work]);
  });

  test("rename keeps the position", async () => {
    const owner = await createUser();
    const work = await store.createSection(owner, "Work");

    const renamed = await store.renameSection(owner, work.id, "Clients");

    expect(renamed).toEqual({ ...work, name: "Clients" });
  });

  test("reorder rewrites every position, and refuses an order that is not exactly theirs", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const first = await store.createSection(owner, "First");
    const second = await store.createSection(owner, "Second");
    const foreign = await store.createSection(stranger, "Theirs");

    const reordered = await store.reorderSections(owner, [second.id, first.id]);
    expect(reordered.map((section) => section.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(reordered.map((section) => section.position)).toEqual([0, 1]);

    for (const order of [
      [first.id],
      [first.id, first.id],
      [first.id, foreign.id],
      [first.id, second.id, foreign.id],
    ]) {
      await expect(store.reorderSections(owner, order)).rejects.toBeInstanceOf(
        SectionOrderError,
      );
    }
  });
});

describe("filing a conversation under a section", () => {
  test("puts the section on the roster row, moves it, and takes it out again", async () => {
    const owner = await createUser();
    const channel = await createChannel(owner, [await createAgent(owner)]);
    const work = await store.createSection(owner, "Work");
    const home = await store.createSection(owner, "Home");

    expect((await rosterRow(owner, channel.id)).sectionId).toBeNull();
    await store.setSection(owner, channel.id, work.id);
    expect((await rosterRow(owner, channel.id)).sectionId).toBe(work.id);
    // One section per chat per person: moving replaces, it does not add a second placement.
    await store.setSection(owner, channel.id, home.id);
    expect((await rosterRow(owner, channel.id)).sectionId).toBe(home.id);
    const placements = await database
      .select()
      .from(channelSections)
      .where(eq(channelSections.channelId, channel.id));
    expect(placements).toHaveLength(1);

    await store.setSection(owner, channel.id, null);
    expect((await rosterRow(owner, channel.id)).sectionId).toBeNull();
  });

  test("deleting a section ungroups its conversations rather than deleting them", async () => {
    const owner = await createUser();
    const channel = await createChannel(owner, [await createAgent(owner)]);
    const work = await store.createSection(owner, "Work");
    await store.setSection(owner, channel.id, work.id);

    await store.deleteSection(owner, work.id);

    expect(await store.listSections(owner)).toEqual([]);
    expect((await rosterRow(owner, channel.id)).sectionId).toBeNull();
  });

  test("one member's sections are invisible to the other member", async () => {
    const { owner, other, channelId } = await sharedChannel();
    const work = await store.createSection(owner, "Work");

    await store.setSection(owner, channelId, work.id);

    expect((await rosterRow(owner, channelId)).sectionId).toBe(work.id);
    expect((await rosterRow(other, channelId)).sectionId).toBeNull();
  });

  test("refuses somebody else's section and a conversation the caller is not in", async () => {
    const { owner, other, channelId } = await sharedChannel();
    const outsider = await createUser();
    const theirs = await store.createSection(other, "Theirs");
    const mine = await store.createSection(outsider, "Mine");

    await expect(
      store.setSection(owner, channelId, theirs.id),
    ).rejects.toBeInstanceOf(SectionNotFoundError);
    await expect(
      store.setSection(outsider, channelId, mine.id),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
    expect((await rosterRow(owner, channelId)).sectionId).toBeNull();
  });
});

describe("marking a conversation unread", () => {
  test("moves the marker to just before the Bot's last message, so it reads as unseen", async () => {
    const { owner, other, agentId, channelId } = await sharedChannel();
    await store.recordActivity(owner, channelId, {
      agentId,
      at: new Date(),
      text: "Filed the receipts.",
    });
    await store.markRead(owner, channelId);
    await store.markRead(other, channelId);

    expect(await store.markUnread(owner, channelId)).toBe(true);

    const row = await rosterRow(owner, channelId);
    const lastMessageAt = iso(row.lastMessageAt);
    const lastReadAt = iso(row.lastReadAt);
    if (lastMessageAt === null || lastReadAt === null) {
      throw new Error("expected both stamps");
    }
    // Compared the way the browser does: millisecond strings, and strictly later.
    expect(lastMessageAt > lastReadAt).toBe(true);
    // The other member read it and still has.
    const theirs = await rosterRow(other, channelId);
    expect((iso(theirs.lastReadAt) ?? "") >= lastMessageAt).toBe(true);
  });

  test("refuses, and writes nothing, when the last message is the person's own", async () => {
    const owner = await createUser();
    const channel = await createChannel(owner, [await createAgent(owner)]);
    await store.recordActivity(owner, channel.id, {
      agentId: null,
      at: new Date(),
      text: "Please file these.",
    });
    await store.markRead(owner, channel.id);
    const before = (await rosterRow(owner, channel.id)).lastReadAt;

    expect(await store.markUnread(owner, channel.id)).toBe(false);
    expect((await rosterRow(owner, channel.id)).lastReadAt).toEqual(before);
  });

  test("refuses a conversation nothing was said in, and one the caller is not in", async () => {
    const owner = await createUser();
    const outsider = await createUser();
    const channel = await createChannel(owner, [await createAgent(owner)]);

    expect(await store.markUnread(owner, channel.id)).toBe(false);
    await expect(store.markUnread(outsider, channel.id)).rejects.toBeInstanceOf(
      ChannelNotFoundError,
    );
  });
});

describe("hiding a conversation from the sidebar", () => {
  test("stamps the caller's membership only, and the roster still lists it", async () => {
    const { owner, other, agentId, channelId } = await sharedChannel();
    await store.recordActivity(owner, channelId, {
      agentId,
      at: new Date(),
      text: "Done.",
    });

    const hiddenAt = await store.setHidden(owner, channelId, true);

    const row = await rosterRow(owner, channelId);
    expect(row.hiddenAt).toEqual(hiddenAt);
    // Never earlier than the last message, or the row would read as spoken in after it was hidden.
    expect((iso(row.hiddenAt) ?? "") >= (iso(row.lastMessageAt) ?? "")).toBe(
      true,
    );
    expect((await rosterRow(other, channelId)).hiddenAt).toBeNull();
  });

  test("comes back when something newer than the stamp is said", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const hiddenAt = await store.setHidden(owner, channel.id, true);
    if (!hiddenAt) throw new Error("expected a stamp");

    await store.recordActivity(owner, channel.id, {
      agentId,
      at: new Date(hiddenAt.getTime() + 5),
      text: "A new answer.",
    });

    const row = await rosterRow(owner, channel.id);
    // The stamp stays; what changed is that something was said after it, which is the browser's
    // rule for drawing the row again (`isHiddenFromSidebar`).
    expect(row.hiddenAt).toEqual(hiddenAt);
    expect((iso(row.lastMessageAt) ?? "") > (iso(row.hiddenAt) ?? "")).toBe(
      true,
    );
  });

  test("shows it again on request, and refuses a conversation the caller is not in", async () => {
    const owner = await createUser();
    const outsider = await createUser();
    const channel = await createChannel(owner, [await createAgent(owner)]);
    await store.setHidden(owner, channel.id, true);

    expect(await store.setHidden(owner, channel.id, false)).toBeNull();
    expect((await rosterRow(owner, channel.id)).hiddenAt).toBeNull();
    await expect(
      store.setHidden(outsider, channel.id, true),
    ).rejects.toBeInstanceOf(ChannelNotFoundError);
  });
});

describe("renaming a Bot", () => {
  test("renames the conversations named after it", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Expense Manager");
    const channel = await createChannel(owner, [agentId]);

    await profileStore.update(owner, agentId, {
      name: "Receipts",
      title: "Finance Operations",
      roleDescription: "Review receipts.",
      visibility: "public",
    });

    expect((await store.get(owner, channel.id))?.name).toBe("Receipts");
    const [stored] = await database
      .select({ name: channels.name })
      .from(channels)
      .where(and(eq(channels.id, channel.id)));
    expect(stored?.name).toBe("Receipts");
  });
});

describe("sidebar routes", () => {
  async function appAs(actor: AgentActor) {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", { ...actor, email: `${actor.id}@example.test` });
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createChannelRoutes(store, requireUser));
    return app;
  }

  const send =
    (app: Hono<{ Variables: AppVariables }>, method: string) =>
    (path: string, body?: unknown) =>
      app.request(path, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
      });

  test("section CRUD answers at /sections, not as a channel id", async () => {
    const owner = await createUser();
    const app = await appAs(owner);

    const created = await send(app, "POST")("/sections", { name: "  Work  " });
    expect(created.status).toBe(201);
    const { section } = (await created.json()) as {
      section: { id: string; name: string };
    };
    expect(section.name).toBe("Work");

    const listed = await send(app, "GET")("/sections");
    expect(await listed.json()).toEqual({
      sections: [{ id: section.id, name: "Work", position: 0 }],
    });

    const renamed = await send(app, "PATCH")(`/sections/${section.id}`, {
      name: "Clients",
    });
    expect(
      ((await renamed.json()) as { section: { name: string } }).section.name,
    ).toBe("Clients");

    const reordered = await send(app, "PUT")("/sections/order", {
      sectionIds: [section.id],
    });
    expect(reordered.status).toBe(200);

    const deleted = await send(app, "DELETE")(`/sections/${section.id}`);
    expect(deleted.status).toBe(204);
    expect((await send(app, "DELETE")(`/sections/${section.id}`)).status).toBe(
      404,
    );
  });

  test("section routes refuse a bad name and a stale order", async () => {
    const owner = await createUser();
    const app = await appAs(owner);

    for (const name of ["", "   ", 7, "x".repeat(61)]) {
      expect((await send(app, "POST")("/sections", { name })).status).toBe(400);
    }
    await store.createSection(owner, "Work");
    expect(
      (await send(app, "PUT")("/sections/order", { sectionIds: [] })).status,
    ).toBe(409);
  });

  test("move, unread and hidden answer on the conversation", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const channel = await createChannel(owner, [agentId]);
    const section = await store.createSection(owner, "Work");
    const app = await appAs(owner);

    const moved = await send(app, "PUT")(`/${channel.id}/section`, {
      sectionId: section.id,
    });
    expect(await moved.json()).toEqual({ sectionId: section.id });
    expect(
      (await send(app, "PUT")(`/${channel.id}/section`, { sectionId: 3 }))
        .status,
    ).toBe(400);
    expect(
      (
        await send(app, "PUT")(`/${channel.id}/section`, {
          sectionId: "section_unknown",
        })
      ).status,
    ).toBe(404);

    // Nothing from a Bot yet: there is nothing to bring the dot back for.
    expect((await send(app, "PUT")(`/${channel.id}/unread`)).status).toBe(409);
    await store.recordActivity(owner, channel.id, {
      agentId,
      at: new Date(),
      text: "Done.",
    });
    expect((await send(app, "PUT")(`/${channel.id}/unread`)).status).toBe(204);

    const hidden = await send(app, "PUT")(`/${channel.id}/hidden`, {
      hidden: true,
    });
    expect(hidden.status).toBe(200);
    expect(
      typeof ((await hidden.json()) as { hiddenAt: unknown }).hiddenAt,
    ).toBe("string");
    expect(
      (await send(app, "PUT")(`/${channel.id}/hidden`, { hidden: "yes" }))
        .status,
    ).toBe(400);

    // And the roster carries both, as strings the browser can compare.
    const roster = (await (await send(app, "GET")("/")).json()) as {
      channels: { id: string; hiddenAt: string | null; sectionId: string }[];
    };
    const row = roster.channels.find((entry) => entry.id === channel.id);
    expect(row?.sectionId).toBe(section.id);
    expect(typeof row?.hiddenAt).toBe("string");
  });
});
