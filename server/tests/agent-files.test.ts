import { describe, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type AgentFile,
  type AgentFilesCursor,
  type AgentFilesPage,
  type AttachmentFiles,
  createAgentFileRoutes,
  decodeAgentFilesCursor,
  encodeAgentFilesCursor,
  newestFirst,
  pageOfAgentFiles,
  type RankedFile,
  type WorkspaceFiles,
  workspaceFiles,
} from "../src/agents/files";
import type { AgentProfile } from "../src/agents/profile-types";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import type { ComputerGateway } from "../src/computer/gateway";
import type { ComputerStatus, ListFilesResult } from "../src/computer/schema";

/**
 * The Library's file list: two stores merged into one order, paged by a cursor that names the whole
 * sort key, and asked only about a Bot the person may see.
 *
 * The attachments half's SQL is exercised against PostgreSQL in agent-files.integration.test.ts.
 * Here the stores are fakes that answer the way it does — newest first, cut at the cursor, one past
 * the page — so the merge and the paging can be walked page by page without a database.
 */

const OWNER: AuthenticatedActor = {
  id: "user-1",
  email: "owner@openbot.test",
  role: "user",
};

function bot(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "bot-1",
    name: "Noë",
    title: "",
    roleDescription: "Helps.",
    avatarSeed: "bot-1",
    visibility: "private",
    ownerUserId: OWNER.id,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
}

/** An attachment as the attachments half ranks it. */
function attachment(uuid: string, sortAt: string, name = "photo.png") {
  const url = `/api/attachments/${uuid}`;
  return {
    sortAt,
    file: {
      id: `attachment:${uuid}`,
      name,
      source: "attachment",
      mimeType: "image/png",
      sizeBytes: 10,
      at: `${sortAt.slice(0, 23)}Z`,
      url,
      thumbnailUrl: url,
    },
  } satisfies RankedFile;
}

/** A workspace file as the workspace half ranks it. */
function saved(path: string, sortAt: string) {
  return {
    sortAt,
    file: {
      id: `workspace:${path}`,
      name: path.split("/").at(-1) ?? path,
      source: "workspace",
      mimeType: "text/csv",
      sizeBytes: 5,
      at: `${sortAt.slice(0, 23)}Z`,
      url: `/api/computers/bot-1/files/download?path=${encodeURIComponent(path)}`,
      thumbnailUrl: null,
    },
  } satisfies RankedFile;
}

const A1 = "00000000-0000-4000-8000-000000000001";
const A2 = "00000000-0000-4000-8000-000000000002";
const A3 = "00000000-0000-4000-8000-000000000003";
const A4 = "00000000-0000-4000-8000-000000000004";

/**
 * Two stores' worth of files, with every kind of tie the order has to break: two attachments in the
 * same microsecond, an attachment and a workspace file in the same microsecond, and two workspace
 * files in the same millisecond.
 */
const ATTACHED: RankedFile[] = [
  attachment(A1, "2026-10-09T12:00:00.000001Z", "oldest.png"),
  attachment(A2, "2026-10-10T09:00:00.123456Z"),
  attachment(A3, "2026-10-10T09:00:00.123456Z"),
  attachment(A4, "2026-10-10T11:00:00.000000Z"),
];
const SAVED: RankedFile[] = [
  saved("report.csv", "2026-10-10T09:00:00.123456Z"),
  saved("notes/a.csv", "2026-10-10T10:00:00.500000Z"),
  saved("notes/b.csv", "2026-10-10T10:00:00.500000Z"),
];

/** Answers the way the SQL does: the merged order, cut at the cursor, one past the page. */
function fakeAttachments(rows: readonly RankedFile[]) {
  const asked: { after?: AgentFilesCursor; limit: number }[] = [];
  const source: AttachmentFiles = async ({ after, limit }) => {
    asked.push({ after, limit });
    return [...rows]
      .sort(newestFirst)
      .filter(
        (row) =>
          !after ||
          row.sortAt < after.at ||
          (row.sortAt === after.at && row.file.id < after.id),
      )
      .slice(0, limit + 1);
  };
  return Object.assign(source, { asked });
}

function actorMiddleware(
  actor: AuthenticatedActor,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", actor);
    await next();
  };
}

function app({
  agent = bot(),
  attachmentFiles = fakeAttachments(ATTACHED),
  workspace = async () => ({ state: "listed" as const, files: SAVED }),
}: {
  agent?: AgentProfile | null;
  attachmentFiles?: AttachmentFiles;
  workspace?: WorkspaceFiles;
} = {}) {
  const asked: string[] = [];
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.route(
    "/api/agents",
    createAgentFileRoutes({
      store: {
        async get(_actor, id) {
          asked.push(id);
          return agent && agent.id === id ? agent : null;
        },
      },
      requireUser: actorMiddleware(OWNER),
      attachmentFiles,
      workspace,
    }),
  );
  return { routes, asked };
}

async function page(
  routes: Hono<{ Variables: AppVariables }>,
  query = "",
): Promise<AgentFilesPage> {
  const response = await routes.request(`/api/agents/bot-1/files${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as AgentFilesPage;
}

const EXPECTED_ORDER = [
  `attachment:${A4}`,
  "workspace:notes/b.csv",
  "workspace:notes/a.csv",
  // Same microsecond: the workspace id sorts above both attachment ids, then the uuids descend.
  "workspace:report.csv",
  `attachment:${A3}`,
  `attachment:${A2}`,
  `attachment:${A1}`,
];

describe("the merged order", () => {
  test("is newest first across both stores, and the id breaks every tie", () => {
    const merged = pageOfAgentFiles({
      attached: ATTACHED,
      workspace: { state: "listed", files: SAVED },
      limit: 50,
    });
    expect(merged.files.map((file) => file.id)).toEqual(EXPECTED_ORDER);
    expect(merged.nextCursor).toBeNull();
    expect(merged.workspace).toBe("listed");
  });
});

describe("paging", () => {
  test("walks every file exactly once, whichever store the next one comes from", async () => {
    const attachmentFiles = fakeAttachments(ATTACHED);
    const { routes } = app({ attachmentFiles });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "?limit=2";
      const body = await page(routes, query);
      expect(body.files.length).toBeLessThanOrEqual(2);
      seen.push(...body.files.map((file: AgentFile) => file.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(seen).toEqual(EXPECTED_ORDER);
    expect(pages).toBe(4);
    // Each page asked the attachments half from where the last one stopped, one past the page.
    expect(attachmentFiles.asked.map((ask) => ask.after?.id)).toEqual([
      undefined,
      "workspace:notes/b.csv",
      "workspace:report.csv",
      `attachment:${A2}`,
    ]);
    expect(attachmentFiles.asked.every((ask) => ask.limit === 2)).toBe(true);
  });

  test("says there is no next page when the last page is exactly full", async () => {
    const { routes } = app();
    const body = await page(routes, "?limit=7");
    expect(body.files).toHaveLength(7);
    expect(body.nextCursor).toBeNull();
  });

  test("a cursor carries the whole sort key, to the microsecond, and reads back", () => {
    const cursor = {
      at: "2026-10-10T09:00:00.123456Z",
      id: `attachment:${A3}`,
    };
    expect(decodeAgentFilesCursor(encodeAgentFilesCursor(cursor))).toEqual(
      cursor,
    );
    expect(
      decodeAgentFilesCursor(
        encodeAgentFilesCursor({
          at: "2026-10-10T09:00:00.123456Z",
          id: "workspace:a/b.txt",
        }),
      ),
    ).toEqual({ at: "2026-10-10T09:00:00.123456Z", id: "workspace:a/b.txt" });
  });

  test("a page marker this list never gave out is refused, not read as page one", async () => {
    const { routes } = app();
    const malformed = [
      "not-base64-json",
      encodeAgentFilesCursor({
        at: "2026-10-10T09:00:00Z",
        id: `attachment:${A1}`,
      }),
      encodeAgentFilesCursor({
        at: "2026-10-10T09:00:00.123456Z",
        id: "attachment:not-a-uuid",
      }),
      encodeAgentFilesCursor({ at: "2026-10-10T09:00:00.123456Z", id: "x:1" }),
    ];
    for (const cursor of malformed) {
      const response = await routes.request(
        `/api/agents/bot-1/files?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(response.status).toBe(400);
    }
  });
});

describe("who may ask", () => {
  test("a Bot the person may not see is not found, and neither store is asked", async () => {
    const attachmentFiles = fakeAttachments(ATTACHED);
    let workspaceAsked = false;
    const { routes, asked } = app({
      agent: null,
      attachmentFiles,
      workspace: async () => {
        workspaceAsked = true;
        return { state: "listed", files: SAVED };
      },
    });
    const response = await routes.request("/api/agents/bot-1/files");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found." });
    expect(asked).toEqual(["bot-1"]);
    expect(attachmentFiles.asked).toHaveLength(0);
    expect(workspaceAsked).toBe(false);
  });

  test("a deployment with neither store answers an empty first page", async () => {
    const routes = new Hono<{ Variables: AppVariables }>();
    routes.route(
      "/api/agents",
      createAgentFileRoutes({
        store: { get: async () => bot() },
        requireUser: actorMiddleware(OWNER),
      }),
    );
    expect(await page(routes)).toEqual({
      files: [],
      nextCursor: null,
      workspace: "none",
    });
  });

  test("a store that fails is a 500 the app can read, not a partial list", async () => {
    const { routes } = app({
      attachmentFiles: async () => {
        throw new Error("connection lost");
      },
    });
    // The fault is logged for whoever runs the server; kept out of the test output here.
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await routes.request("/api/agents/bot-1/files");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Could not load this Bot's files.",
      });
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});

/** A gateway that answers `status` and `listFiles`, and records whether it was asked. */
function fakeGateway({
  state = "ready",
  listing,
  fails = false,
}: {
  state?: ComputerStatus["state"];
  listing?: ListFilesResult;
  fails?: boolean;
}) {
  const calls: { method: string; actor?: unknown }[] = [];
  const gateway = {
    async status(botId: string): Promise<ComputerStatus> {
      calls.push({ method: "status" });
      return { botId, state };
    },
    async listFiles(_botId: string, actor: unknown): Promise<ListFilesResult> {
      calls.push({ method: "listFiles", actor });
      if (fails) throw new Error("refused by a rule");
      return listing ?? { path: ".", entries: [], truncated: false };
    },
  } as unknown as ComputerGateway;
  return { gateway, calls };
}

describe("the workspace half", () => {
  test("lists files with their last write, and leaves out folders, dot paths and undated entries", async () => {
    const { gateway, calls } = fakeGateway({
      listing: {
        path: ".",
        truncated: false,
        entries: [
          { path: "reports", kind: "folder" },
          {
            path: "reports/august summary.csv",
            kind: "file",
            bytes: 12,
            modifiedAt: "2026-10-10T08:00:00.250Z",
          },
          {
            path: "shot.png",
            kind: "file",
            bytes: 900,
            modifiedAt: "2026-10-01T08:00:00.000Z",
          },
          {
            path: ".git/HEAD",
            kind: "file",
            bytes: 1,
            modifiedAt: "2026-10-10T08:00:00.000Z",
          },
          { path: "undated.txt", kind: "file", bytes: 1 },
        ],
      },
    });
    const listed = await workspaceFiles(gateway)(bot(), OWNER);
    expect(listed.state).toBe("listed");
    expect(listed.files).toEqual([
      {
        sortAt: "2026-10-10T08:00:00.250000Z",
        file: {
          id: "workspace:reports/august summary.csv",
          name: "august summary.csv",
          source: "workspace",
          mimeType: "text/csv",
          sizeBytes: 12,
          at: "2026-10-10T08:00:00.250Z",
          url: "/api/computers/bot-1/files/download?path=reports%2Faugust%20summary.csv",
          thumbnailUrl: null,
        },
      },
      {
        sortAt: "2026-10-01T08:00:00.000000Z",
        file: {
          id: "workspace:shot.png",
          name: "shot.png",
          source: "workspace",
          mimeType: "image/png",
          sizeBytes: 900,
          at: "2026-10-01T08:00:00.000Z",
          url: "/api/computers/bot-1/files/download?path=shot.png",
          // The governed download is the only way to a workspace image's bytes: no thumbnail.
          thumbnailUrl: null,
        },
      },
    ]);
    // Listed as the person, so the trail names them.
    expect(calls).toEqual([
      { method: "status" },
      { method: "listFiles", actor: { id: OWNER.id, userId: OWNER.id } },
    ]);
  });

  test("a computer that is not running is not started to list it", async () => {
    for (const state of ["absent", "starting"] as const) {
      const { gateway, calls } = fakeGateway({ state });
      expect(await workspaceFiles(gateway)(bot(), OWNER)).toEqual({
        state: "off",
        files: [],
      });
      expect(calls.map((call) => call.method)).toEqual(["status"]);
    }
    const { gateway } = fakeGateway({ state: "unreachable" });
    expect((await workspaceFiles(gateway)(bot(), OWNER)).state).toBe(
      "unavailable",
    );
  });

  test("a refused or failed listing is 'unavailable', not an error for the whole list", async () => {
    const { gateway } = fakeGateway({ fails: true });
    expect(await workspaceFiles(gateway)(bot(), OWNER)).toEqual({
      state: "unavailable",
      files: [],
    });
  });

  test("a Team Bot's teammate sees no workspace, and the computer is not asked", async () => {
    const { gateway, calls } = fakeGateway({});
    const teammate: AuthenticatedActor = {
      id: "user-2",
      email: "teammate@openbot.test",
      role: "user",
    };
    expect(await workspaceFiles(gateway)(bot(), teammate)).toEqual({
      state: "none",
      files: [],
    });
    expect(calls).toHaveLength(0);
    // A public Bot's computer is everybody's, so it is listed for them.
    await workspaceFiles(gateway)(bot({ visibility: "public" }), teammate);
    expect(calls.map((call) => call.method)).toEqual(["status", "listFiles"]);
  });
});
