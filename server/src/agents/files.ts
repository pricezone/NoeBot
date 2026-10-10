import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { attachmentUrl, classifyAttachment } from "../../../shared/attachments";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import type { ActionActor, ComputerGateway } from "../computer/gateway";
import type { WorkspaceEntry } from "../computer/schema";
import type { Database } from "../db/client";
import {
  attachments,
  channelAgents,
  channelMemberships,
  channels,
} from "../db/schema";
import { canUseComputer } from "./computer-access";
import type { AgentProfileStore } from "./profile-store";
import type { AgentProfile } from "./profile-types";

/**
 * A Bot's files, newest first: what was attached in its conversations, and what is in its
 * workspace.
 *
 * This is the list the Bot panel's Library opens with. Two stores answer it and neither knows about
 * the other, so they are merged here into one order: the attachments table (every file sent in a
 * channel this Bot is in, whoever sent it) and the Bot's workspace on its computer (what it saved
 * while working). Each file says what it is, how to open it, and whether there is a picture of it.
 *
 * ONE ORDER ACROSS BOTH, AND THE CURSOR NAMES ALL OF IT. Newest first by timestamp, and by `id`
 * where two files share one, because a keyset cursor that names less than the whole sort key serves
 * some files twice and others never. The timestamp is compared to the MICROSECOND, as text, for the
 * channel roster's reason (`channels/routes.ts`): `attachments.created_at` keeps microseconds and a
 * `Date` keeps milliseconds, so a cursor built from a `Date` would name a moment just before its own
 * row, and every file later in that millisecond would be on no page at all.
 *
 * The workspace is listed whole on every page (the computer bounds a listing at 500 entries) and
 * cut at the cursor here; the attachments are cut at the cursor in SQL and read one past the page,
 * so whichever store the next file comes from, the page and the "is there more" are both right.
 */

/** Where a file lives, which decides how it opens. */
export type AgentFileSource = "attachment" | "workspace";

/** One file, as the Library draws it. */
export type AgentFile = {
  /**
   * Stable across pages and reloads: `attachment:<uuid>` or `workspace:<path>`. Also the last part
   * of the sort key, so it is never shortened or rewritten.
   */
  id: string;
  name: string;
  source: AgentFileSource;
  /**
   * For an attachment, the type the server sniffed from the bytes when it was uploaded. For a
   * workspace file, a guess from the extension: nothing has looked at those bytes, so this is only
   * ever used to pick an icon, never to serve the file.
   */
  mimeType: string;
  sizeBytes: number | null;
  /** When it was attached, or when the workspace file was last written. ISO 8601, milliseconds. */
  at: string;
  /** Where the app opens or downloads it. Same-origin, through the route that checks access. */
  url: string;
  /**
   * A picture of it, or null when only an icon can stand for it.
   *
   * Only an image attachment has one. A workspace image does not: the only way to its bytes is the
   * governed download, which writes a "downloaded" row to the audit trail and reads the whole file,
   * and a thumbnail drawn on every visit to the Library would be neither true in the trail nor cheap.
   */
  thumbnailUrl: string | null;
};

/**
 * Whether the workspace half is in the list, so the Library can say why it might be missing.
 *
 * - `listed`: it is.
 * - `off`: the Bot's computer is not running, and the list did not start it. Opening a tab is not a
 *   reason to boot a computer.
 * - `unavailable`: the computer could not be reached, or would not list (a rule may refuse it).
 * - `none`: there is no workspace this person may see: no computer on this deployment, or a Team
 *   Bot whose computer is its owner's (see `canUseComputer`).
 */
export type WorkspaceListing = "listed" | "off" | "unavailable" | "none";

export type AgentFilesPage = {
  files: AgentFile[];
  /** Null on the last page. */
  nextCursor: string | null;
  workspace: WorkspaceListing;
};

/** A file with the timestamp it sorts on: UTC, to the microsecond, in one fixed-width form. */
export type RankedFile = { file: AgentFile; sortAt: string };

/** Where a page stopped: the whole sort key of its last file. */
export type AgentFilesCursor = { at: string; id: string };

/** The sorting form of a timestamp. Fixed width, so comparing the text compares the moments. */
const SORT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATTACHMENT_ID = "attachment:";
const WORKSPACE_ID = "workspace:";

const DEFAULT_PAGE = 50;
/** The most a caller may ask for, so the endpoint cannot be talked back into reading everything. */
const MAX_PAGE = 100;

/** Newest first, then by id, both descending. The one order every page and the cursor agree on. */
export function newestFirst(a: RankedFile, b: RankedFile): number {
  if (a.sortAt !== b.sortAt) return a.sortAt < b.sortAt ? 1 : -1;
  if (a.file.id === b.file.id) return 0;
  return a.file.id < b.file.id ? 1 : -1;
}

/** Whether a file comes strictly after where the cursor stopped. */
function comesAfter(file: RankedFile, cursor: AgentFilesCursor): boolean {
  return (
    file.sortAt < cursor.at ||
    (file.sortAt === cursor.at && file.file.id < cursor.id)
  );
}

export function encodeAgentFilesCursor(cursor: AgentFilesCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A page marker read back, or undefined for one this list never gave out.
 *
 * Refused rather than read as the first page, unlike the channel roster's: this list is appended to
 * as the person scrolls, and answering a stale marker with page one would draw every file twice.
 * The id is checked down to its uuid because an attachment cursor's id reaches PostgreSQL as one,
 * where anything else is `22P02` rather than a refusal.
 */
export function decodeAgentFilesCursor(
  value: string,
): AgentFilesCursor | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<AgentFilesCursor> | null;
    const at = parsed?.at;
    const id = parsed?.id;
    if (typeof at !== "string" || !SORT_AT.test(at)) return undefined;
    if (Number.isNaN(Date.parse(displayAt(at)))) return undefined;
    if (typeof id !== "string") return undefined;
    const isAttachment =
      id.startsWith(ATTACHMENT_ID) && UUID.test(id.slice(ATTACHMENT_ID.length));
    const isWorkspace =
      id.startsWith(WORKSPACE_ID) && id.length > WORKSPACE_ID.length;
    return isAttachment || isWorkspace ? { at, id } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One page of the merged list.
 *
 * `attached` is the next attachments after the cursor, one more than a page if there are that many;
 * `workspace` is the whole listing. Both are cut at the cursor again here, so a store whose own cut
 * disagreed with this order by a tie could not put a file on two pages.
 */
export function pageOfAgentFiles({
  attached,
  workspace,
  after,
  limit,
}: {
  attached: readonly RankedFile[];
  workspace: { state: WorkspaceListing; files: readonly RankedFile[] };
  after?: AgentFilesCursor;
  limit: number;
}): AgentFilesPage {
  const candidates = [...attached, ...workspace.files]
    .filter((file) => !after || comesAfter(file, after))
    .sort(newestFirst);
  const page = candidates.slice(0, limit);
  const last = page.at(-1);
  return {
    files: page.map((ranked) => ranked.file),
    nextCursor:
      candidates.length > limit && last
        ? encodeAgentFilesCursor({ at: last.sortAt, id: last.file.id })
        : null,
    workspace: workspace.state,
  };
}

/** The milliseconds form of a sorting timestamp, for the screen. */
function displayAt(sortAt: string): string {
  return `${sortAt.slice(0, 23)}Z`;
}

/** Sent attachments in this Bot's channels that this person is in, newest first, after `after`. */
export type AttachmentFiles = (query: {
  actorId: string;
  agentId: string;
  after?: AgentFilesCursor;
  limit: number;
}) => Promise<RankedFile[]>;

/**
 * The attachments half, read from the attachments table.
 *
 * WHICH ROWS. Every file sent in a channel the Bot is part of, by anybody in it — the person's own
 * uploads and a colleague's in a shared channel alike — but only channels THIS PERSON is a member
 * of and that have not been deleted. That is the same channel-and-membership join
 * `GET /api/attachments/:id` decides access with, so every url this hands out is one that route will
 * serve. Staged rows (`attached_at` null) are left out: a file picked and never sent is a draft in
 * somebody's composer, not a file in the conversation.
 *
 * `bytes` is not selected. It is the TOASTed blob, and naming it would read every file to list them.
 */
export function channelAttachmentFiles(database: Database): AttachmentFiles {
  return async ({ actorId, agentId, after, limit }) => {
    const rows = await database
      .select({
        id: attachments.id,
        name: attachments.name,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
        sortAt: sql<string>`to_char(${attachments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(attachments)
      .innerJoin(
        channels,
        and(eq(channels.id, attachments.channelId), isNull(channels.deletedAt)),
      )
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, attachments.channelId),
          eq(channelAgents.agentId, agentId),
        ),
      )
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, attachments.channelId),
          eq(channelMemberships.userId, actorId),
        ),
      )
      .where(and(isNotNull(attachments.attachedAt), attachmentsAfter(after)))
      .orderBy(desc(attachments.createdAt), desc(attachments.id))
      // One past the page, so "is there more" needs no count.
      .limit(limit + 1);

    return rows.map((row) => {
      const url = attachmentUrl(row.id);
      return {
        sortAt: row.sortAt,
        file: {
          id: `${ATTACHMENT_ID}${row.id}`,
          name: row.name,
          source: "attachment",
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          at: displayAt(row.sortAt),
          url,
          thumbnailUrl:
            classifyAttachment(row.mimeType) === "image" ? url : null,
        },
      };
    });
  };
}

/**
 * The attachments after a cursor, in the merged order.
 *
 * At the cursor's own timestamp the id decides, and every attachment id sorts below every workspace
 * id (`attachment:` < `workspace:`). So after an attachment, the ones at the same moment with a
 * smaller uuid follow — PostgreSQL orders a `uuid` by its bytes, which is the order of its lowercase
 * text — and after a workspace file, every attachment at the same moment does.
 */
function attachmentsAfter(cursor: AgentFilesCursor | undefined) {
  if (!cursor) return undefined;
  if (cursor.id.startsWith(ATTACHMENT_ID)) {
    const uuid = cursor.id.slice(ATTACHMENT_ID.length);
    return sql`(${attachments.createdAt}, ${attachments.id}) < (${cursor.at}::timestamptz, ${uuid}::uuid)`;
  }
  return sql`${attachments.createdAt} <= ${cursor.at}::timestamptz`;
}

/** The workspace half for one Bot, as this person may see it. Never throws. */
export type WorkspaceFiles = (
  agent: AgentProfile,
  actor: AuthenticatedActor,
) => Promise<{ state: WorkspaceListing; files: RankedFile[] }>;

/** The local development actor, which is not a `users` row. See `actorOf` in computer/routes.ts. */
const DEV_ACTOR_EMAIL = "dev@openbot.local";

/**
 * The workspace half, listed through the computer gateway.
 *
 * THROUGH THE GATEWAY, NOT AROUND IT, so a rule that denies a folder hides it here as it does from
 * the Bot, and the listing is in the trail like every other one. That costs an audit row per page
 * opened, which is the price of the trail meaning what it says.
 *
 * ONLY A RUNNING COMPUTER IS ASKED. `listFiles` locates the computer first, and on a per-Bot provider
 * locating is what creates or wakes one: listing a Library would otherwise boot a machine for every
 * Bot somebody glanced at. A computer that is not up answers `off`, and its files appear once it is.
 *
 * Only for somebody who may use the computer (`canUseComputer`): a Team Bot's teammate talks to
 * the Bot, but its workspace is its owner's, and so is the download route these urls point at.
 */
export function workspaceFiles(gateway: ComputerGateway): WorkspaceFiles {
  return async (agent, actor) => {
    if (!canUseComputer(agent, actor)) return { state: "none", files: [] };
    const status = await gateway.status(agent.id).catch(() => null);
    if (!status || status.state === "unreachable") {
      return { state: "unavailable", files: [] };
    }
    if (status.state !== "ready") return { state: "off", files: [] };
    const asker: ActionActor = {
      id: actor.id,
      ...(actor.email === DEV_ACTOR_EMAIL ? {} : { userId: actor.id }),
    };
    try {
      const listing = await gateway.listFiles(agent.id, asker, {});
      return {
        state: "listed",
        files: listing.entries.flatMap((entry) =>
          workspaceFile(agent.id, entry),
        ),
      };
    } catch {
      return { state: "unavailable", files: [] };
    }
  };
}

/**
 * One workspace entry as a file, or nothing.
 *
 * Folders are left out (the list is of files), and so is anything under a dot: `.git`, a tool's
 * `.cache`, a `.env` the Bot keeps for itself. They are the workspace's plumbing rather than its
 * work, and a recursive listing of one checkout would otherwise fill the Library with them. An
 * entry with no `modifiedAt` cannot be placed in the order and is left out too; every computer this
 * server ships beside sends one.
 */
function workspaceFile(agentId: string, entry: WorkspaceEntry): RankedFile[] {
  if (entry.kind !== "file" || !entry.modifiedAt) return [];
  const segments = entry.path.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return [];
  const moment = new Date(entry.modifiedAt);
  if (Number.isNaN(moment.getTime())) return [];
  const iso = moment.toISOString();
  const name = segments.at(-1) ?? entry.path;
  return [
    {
      // Milliseconds padded to the sorting width. A file's mtime is finer than that on most
      // filesystems, but the computer reports a `Date`, and the order only needs to be one order.
      sortAt: iso.replace(/Z$/, "000Z"),
      file: {
        id: `${WORKSPACE_ID}${entry.path}`,
        name,
        source: "workspace",
        mimeType: mimeTypeFromName(name),
        sizeBytes: entry.bytes ?? null,
        at: iso,
        url: `/api/computers/${encodeURIComponent(agentId)}/files/download?path=${encodeURIComponent(entry.path)}`,
        thumbnailUrl: null,
      },
    },
  ];
}

/** Extensions a Bot commonly writes, and the type that picks their icon. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  js: "text/javascript",
  ts: "text/x-typescript",
  py: "text/x-python",
  sh: "application/x-sh",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** A guess from the name, for the icon only. Unknown is `application/octet-stream`. */
export function mimeTypeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** `?limit=`, bounded, with anything unreadable meaning the default. */
function pageSize(value: string | undefined): number {
  const asked = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(asked)) return DEFAULT_PAGE;
  return Math.min(Math.max(asked, 1), MAX_PAGE);
}

/**
 * `GET /:agentId/files?cursor=`, mounted beside the other agent routes at `/api/agents`.
 *
 * The Bot is asked of the profile store first, as every other agent route does, so a Bot somebody
 * may not see is "not found" here too, rather than a list of what is in its conversations. Either
 * half may be absent: a deployment with no attachment store lists only workspaces, and one with no
 * computer only attachments.
 */
export function createAgentFileRoutes({
  store,
  requireUser,
  attachmentFiles,
  workspace,
}: {
  store: Pick<AgentProfileStore, "get">;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  attachmentFiles?: AttachmentFiles;
  workspace?: WorkspaceFiles;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/:agentId/files", requireUser, async (context) => {
    const agentId = context.req.param("agentId");
    if (!agentId.trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    const marker = context.req.query("cursor");
    const after = marker ? decodeAgentFilesCursor(marker) : undefined;
    if (marker && !after) {
      return context.json(
        { error: "That page marker is not one this list gave out." },
        400,
      );
    }
    const limit = pageSize(context.req.query("limit"));
    const actor = context.var.actor;

    try {
      const agent = await store.get(actor, agentId);
      if (!agent) return context.json({ error: "Agent not found." }, 404);

      const [attached, listed] = await Promise.all([
        attachmentFiles
          ? attachmentFiles({ actorId: actor.id, agentId, after, limit })
          : Promise.resolve([]),
        workspace
          ? workspace(agent, actor)
          : Promise.resolve({ state: "none" as const, files: [] }),
      ]);
      return context.json(
        pageOfAgentFiles({ attached, workspace: listed, after, limit }),
      );
    } catch (error) {
      console.error(`Could not list the files of ${agentId}.`, error);
      return context.json({ error: "Could not load this Bot's files." }, 500);
    }
  });

  return routes;
}
