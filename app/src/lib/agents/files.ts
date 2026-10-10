import { infiniteQueryOptions } from "@tanstack/react-query";
import { agentApiPath, agentKeys } from "@/lib/agents/queries";
import { client } from "@/lib/client";

/**
 * A Bot's files as the Library lists them: what was attached in its conversations and what it saved
 * on its computer, newest first. The server merges the two (`server/src/agents/files.ts`); this is
 * its answer, and the two rules the Library draws it by: which group a file falls in, and how old it
 * reads.
 */

/** Where a file lives, which decides how it opens. */
export type AgentFileSource = "attachment" | "workspace";

/** One file, as the server describes it. */
export type AgentFile = {
  /** Stable across pages: `attachment:<uuid>` or `workspace:<path>`. */
  id: string;
  name: string;
  source: AgentFileSource;
  /** For a workspace file a guess from its extension, so it is only ever used to pick an icon. */
  mimeType: string;
  sizeBytes: number | null;
  /** When it was attached, or when the workspace file was last written. ISO 8601. */
  at: string;
  /** Same-origin: the route that checks access serves it, or downloads it. */
  url: string;
  /** A picture of it — an image attachment's own url — or null when only an icon can stand for it. */
  thumbnailUrl: string | null;
};

/**
 * Whether the workspace half is in the list: `off` means the Bot's computer is not running (the list
 * does not start it), `unavailable` that it could not be listed, `none` that there is no workspace
 * this person may see. Only the first two are worth a sentence.
 */
export type WorkspaceListing = "listed" | "off" | "unavailable" | "none";

export type AgentFilesPage = {
  files: AgentFile[];
  nextCursor: string | null;
  workspace: WorkspaceListing;
};

export function agentFilesQueryOptions(agentId: string) {
  return infiniteQueryOptions({
    queryKey: agentKeys.files(agentId),
    initialPageParam: "",
    queryFn: async ({ pageParam }): Promise<AgentFilesPage> => {
      const suffix = pageParam
        ? `?cursor=${encodeURIComponent(pageParam)}`
        : "";
      const response = await client(`${agentApiPath(agentId)}/files${suffix}`, {
        fallback: "Could not load this Bot's files",
      });
      return (await response.json()) as AgentFilesPage;
    },
    getNextPageParam: (page: AgentFilesPage) => page.nextCursor ?? undefined,
  });
}

/** The Library's three groups, newest first. */
export type FileGroupId = "today" | "week" | "older";

export type FileGroup = { id: FileGroupId; label: string; files: AgentFile[] };

const GROUP_LABEL: Record<FileGroupId, string> = {
  today: "Today",
  week: "Last 7 days",
  older: "Older",
};

/**
 * The files in their groups, in order, leaving out a group with nothing in it.
 *
 * By the reader's own calendar: "Today" starts at their midnight, not 24 hours ago, so a file from
 * last night is not "today" at nine in the morning. "Last 7 days" is the seven days before that. A
 * date in the future — a computer whose clock runs ahead — is today rather than nowhere. The files
 * arrive newest first and keep their order inside a group.
 */
export function groupFilesByAge(
  files: readonly AgentFile[],
  now: Date = new Date(),
): FileGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  // By the calendar rather than by 7 × 24 hours, so a change of clocks does not move the line.
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 7);

  const groups: Record<FileGroupId, AgentFile[]> = {
    today: [],
    week: [],
    older: [],
  };
  for (const file of files) {
    const at = Date.parse(file.at);
    const id: FileGroupId =
      Number.isNaN(at) || at < startOfWeek.getTime()
        ? "older"
        : at < startOfToday.getTime()
          ? "week"
          : "today";
    groups[id].push(file);
  }
  return (["today", "week", "older"] as const)
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, label: GROUP_LABEL[id], files: groups[id] }));
}

/**
 * How long ago, in the fewest characters that still say it: `now`, `5m`, `3h`, `20d`, `2y`.
 *
 * The Library's rows are one line each, and a full date beside a long name is what gets cut. The
 * exact moment is the row's tooltip instead. Anything under a minute, and anything in the future, is
 * `now`.
 */
export function compactAge(at: string, now: Date = new Date()): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor(Math.max(0, now.getTime() - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}
