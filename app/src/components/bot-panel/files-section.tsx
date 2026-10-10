import {
  IconFile,
  IconFileCode,
  IconFileMusic,
  IconFileSpreadsheet,
  IconFileText,
  IconFileTypePdf,
  IconFileZip,
  IconMovie,
  IconPhoto,
} from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useMemo, useState } from "react";
import { AttachmentLightbox } from "@/components/channels/chat-transcript";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentFile,
  agentFilesQueryOptions,
  compactAge,
  type FileGroup,
  type FileGroupId,
  groupFilesByAge,
} from "@/lib/agents/files";
import { cn } from "@/lib/utils";

/** Rows a group shows before "Show more", and how many more each press shows. */
export const FILES_PER_GROUP = 5;
const SHOW_MORE_STEP = 10;

/**
 * The Library's file history: what was attached in this Bot's conversations and what it saved on
 * its computer, newest first, in "Today", "Last 7 days" and "Older".
 *
 * Grok's shape: a quiet label over each group, then a card of one-line rows — a thumbnail, the name,
 * and how long ago — with "Show more" at the foot of a group that has more than five. A row opens
 * its file the way the conversation does: an image attachment in the same lightbox the transcript
 * uses, anything else as a download from the route that checks access.
 *
 * The list is paged by the server, newest first, so only the LAST group drawn can have more than has
 * arrived: every group above it is complete. Its "Show more" asks for the next page once the rows
 * already here run out.
 */
export function FilesSection({ agentId }: { agentId: string }) {
  const files = useInfiniteQuery(agentFilesQueryOptions(agentId));
  const [shown, setShown] = useState<Partial<Record<FileGroupId, number>>>({});

  const loaded = useMemo(
    () => files.data?.pages.flatMap((page) => page.files) ?? [],
    [files.data],
  );
  const groups = useMemo(() => groupFilesByAge(loaded), [loaded]);
  const workspace = files.data?.pages[0]?.workspace;

  if (files.isPending) return <FilesSkeleton />;
  if (!files.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {files.error?.message ?? "Could not load this Bot's files"}
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      {groups.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          No files yet. What you attach in a conversation with this Bot, and
          what it saves on its computer, shows up here.
        </p>
      ) : null}
      {groups.map((group, index) => {
        const trailing = index === groups.length - 1;
        const visible = shown[group.id] ?? FILES_PER_GROUP;
        const more =
          group.files.length > visible || (trailing && files.hasNextPage);
        return (
          <FileGroupCard
            group={group}
            key={group.id}
            loadingMore={trailing && files.isFetchingNextPage}
            onShowMore={
              more
                ? () => {
                    const next = visible + SHOW_MORE_STEP;
                    setShown((current) => ({ ...current, [group.id]: next }));
                    // Only the last group can continue on the server: see above.
                    if (
                      trailing &&
                      files.hasNextPage &&
                      !files.isFetchingNextPage &&
                      next > group.files.length
                    ) {
                      void files.fetchNextPage();
                    }
                  }
                : undefined
            }
            visible={visible}
          />
        );
      })}
      {/* A later page that failed keeps what already arrived on screen, and says so under it. */}
      {files.isFetchNextPageError ? (
        <p className="text-sm text-destructive" role="alert">
          {files.error?.message ?? "Could not load more files"}
        </p>
      ) : null}
      {workspace === "off" || workspace === "unavailable" ? (
        <p className="text-[13px] text-muted-foreground">
          {workspace === "off"
            ? "Files on this Bot's computer show here while the computer is on."
            : "The files on this Bot's computer could not be listed just now."}
        </p>
      ) : null}
    </div>
  );
}

function FileGroupCard({
  group,
  visible,
  onShowMore,
  loadingMore,
}: {
  group: FileGroup;
  visible: number;
  /** Absent when the group has nothing more to show. */
  onShowMore?: () => void;
  loadingMore: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-2">
      <h3 className="px-1 text-[13px] text-muted-foreground" id={headingId}>
        {group.label}
      </h3>
      <div className="rounded-2xl border border-border p-1">
        <ul className="flex flex-col">
          {group.files.slice(0, visible).map((file) => (
            <li key={file.id}>
              <FileRow file={file} />
            </li>
          ))}
        </ul>
        {onShowMore ? (
          <button
            className="w-full rounded-xl py-2 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"
            disabled={loadingMore}
            onClick={onShowMore}
            type="button"
          >
            {loadingMore ? "Loading…" : "Show more"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** The row's own shape, shared by the lightbox trigger and the download link. */
const ROW =
  "group/file flex h-10 w-full min-w-0 items-center gap-3 rounded-xl px-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One file, and what clicking it does.
 *
 * An image attachment opens in the transcript's lightbox. Everything else is a link to its own url
 * with `download`: an attachment's route answers a non-image with `Content-Disposition: attachment`
 * already, and a workspace file's goes through the computer's governed download, which never
 * renders anything on this origin.
 */
function FileRow({ file }: { file: AgentFile }) {
  const body = (
    <>
      <FileThumbnail file={file} />
      <span className="min-w-0 flex-1 truncate">{file.name}</span>
      <FileAge at={file.at} />
    </>
  );
  if (file.source === "attachment" && file.thumbnailUrl) {
    return (
      <AttachmentLightbox
        className={cn(ROW, "cursor-pointer overflow-visible")}
        filename={file.name}
        url={file.url}
      >
        {body}
      </AttachmentLightbox>
    );
  }
  return (
    <a className={ROW} download={file.name} href={file.url} title={file.name}>
      {body}
    </a>
  );
}

/**
 * How long ago, revealed on the row under the pointer as Grok does, and always shown where there is
 * no pointer to hover with. The exact moment is its tooltip.
 */
function FileAge({ at }: { at: string }) {
  const moment = new Date(at);
  return (
    <time
      className="shrink-0 text-[13px] text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover/file:opacity-100 group-focus-visible/file:opacity-100 [@media(hover:none)]:opacity-100"
      dateTime={at}
      title={
        Number.isNaN(moment.getTime()) ? undefined : moment.toLocaleString()
      }
    >
      {compactAge(at)}
    </time>
  );
}

/** A picture of the file where there is one, and an icon for its kind where there is not. */
function FileThumbnail({ file }: { file: AgentFile }) {
  const [failed, setFailed] = useState(false);
  if (file.thumbnailUrl && !failed) {
    return (
      <img
        alt=""
        className="size-7 shrink-0 rounded-md border border-border object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
        src={file.thumbnailUrl}
      />
    );
  }
  return (
    <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-muted/40 text-muted-foreground">
      {fileIcon(file)}
    </span>
  );
}

/** The icon for a file's kind, from its type and, failing that, its extension. */
export function fileIcon(
  file: Pick<AgentFile, "mimeType" | "name">,
): ReactNode {
  const type = file.mimeType.toLowerCase();
  const extension = file.name.includes(".")
    ? (file.name.split(".").at(-1)?.toLowerCase() ?? "")
    : "";
  const className = "size-4";
  if (type.startsWith("image/")) return <IconPhoto className={className} />;
  if (type === "application/pdf") {
    return <IconFileTypePdf className={className} />;
  }
  if (type.startsWith("video/")) return <IconMovie className={className} />;
  if (type.startsWith("audio/")) return <IconFileMusic className={className} />;
  if (
    ["csv", "tsv", "xls", "xlsx", "ods"].includes(extension) ||
    type === "text/csv"
  ) {
    return <IconFileSpreadsheet className={className} />;
  }
  if (["zip", "gz", "tgz", "tar", "rar", "7z"].includes(extension)) {
    return <IconFileZip className={className} />;
  }
  if (
    [
      "js",
      "ts",
      "tsx",
      "py",
      "sh",
      "json",
      "html",
      "css",
      "xml",
      "yaml",
      "yml",
    ].includes(extension)
  ) {
    return <IconFileCode className={className} />;
  }
  if (
    type.startsWith("text/") ||
    ["md", "txt", "docx", "doc"].includes(extension)
  ) {
    return <IconFileText className={className} />;
  }
  return <IconFile className={className} />;
}

function FilesSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-2">
      <Skeleton className="h-3 w-12" />
      <div className="grid gap-1 rounded-2xl border border-border p-2">
        {[0, 1, 2].map((row) => (
          <div className="flex items-center gap-3" key={row}>
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
