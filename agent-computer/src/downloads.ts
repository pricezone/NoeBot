/**
 * Files a page downloads, saved into the Bot's workspace, within limits.
 *
 * A Bot asked for a statement clicked "Download PDF" and the file went nowhere it could reach:
 * Playwright keeps downloads in a temporary folder that is deleted with the browser. Now a download
 * is saved under `Downloads/` in the workspace, through the same path guards the file tools use, and
 * the action that started it answers with `page.download` (where, and how big).
 *
 * Bounded, because any site can start a download and a computer's disk is shared by everything on
 * it: one file may be at most `fileBytes` (watched while it arrives, and cancelled past it), the
 * folder at most `folderBytes`, and a download that no acting call started (none running, nor one
 * just finished) is cancelled outright. Each refusal is said in the next result's `page.notes`.
 *
 * Playwright types only; the workspace is passed in, so a test can give it a temporary one.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import type { BrowserContext, Download } from "playwright";

export type SavedDownload = { path: string; bytes: number };

type Outcome = SavedDownload | { failed: string; name: string };

/** The folder downloads land in, relative to the workspace root. */
export const DOWNLOADS_FOLDER = "Downloads";

/** How long an action waits for a download it started to finish saving. */
export const DOWNLOAD_WAIT_MS = 20_000;

export type DownloadLimits = {
  /** Largest single file kept. */
  fileBytes: number;
  /** Most the Downloads folder may hold. */
  folderBytes: number;
  /** How long after an acting call ends a download it started is still accepted. */
  graceMs: number;
  /** How often a download in progress is measured against `fileBytes`. */
  watchMs: number;
};

export const DEFAULT_DOWNLOAD_LIMITS: DownloadLimits = {
  fileBytes: 100 * 1024 * 1024,
  folderBytes: 1024 * 1024 * 1024,
  graceMs: 5_000,
  watchMs: 500,
};

/**
 * Where the browser writes downloads while they arrive (Playwright's `downloadsPath`), per Bot,
 * so they can be measured as they grow. Outside the workspace: a partial file is not the Bot's.
 */
export function partialDownloadsDir(botId: string): string {
  return join(tmpdir(), "openbot-downloads", botId);
}

/** A file name a site suggested, made safe to put on disk: no folders, no control characters. */
export function safeFileName(suggested: string): string {
  const name = suggested
    .split(/[\\/]/)
    .pop()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
    ?.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!name) return "download";
  if (name.length <= 120) return name;
  const extension = extname(name).slice(0, 12);
  return `${name.slice(0, 120 - extension.length)}${extension}`;
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Total size of the files under a directory, stopping once it is past `limit`. */
async function sizeOf(directory: string, limit: number): Promise<number> {
  let total = 0;
  const walk = async (folder: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (total > limit) return;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile())
        total += (await stat(full).catch(() => null))?.size ?? 0;
    }
  };
  await walk(directory);
  return total;
}

type Arriving = Pick<
  Download,
  "suggestedFilename" | "saveAs" | "cancel" | "path" | "delete"
>;

export type DownloadKeeper = ReturnType<typeof createDownloadKeeper>;

export function createDownloadKeeper(
  workspace: {
    resolvePath(requested: string, forWrite: boolean): Promise<string>;
  },
  options: {
    limits?: Partial<DownloadLimits>;
    /** Where this Bot's browser writes downloads as they arrive. See `partialDownloadsDir`. */
    partialDir?: (botId: string) => string;
    now?: () => number;
  } = {},
) {
  const limits = { ...DEFAULT_DOWNLOAD_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const inFlight = new Map<string, Promise<Outcome>[]>();
  const arriving = new Map<string, Set<Arriving>>();
  const refusals = new Map<string, string[]>();
  const acting = new Map<string, { running: number; endedAt: number }>();
  const watchers = new Map<string, ReturnType<typeof setInterval>>();
  const attached = new WeakSet<object>();

  const refuse = (botId: string, note: string) => {
    const list = refusals.get(botId) ?? [];
    list.push(note);
    refusals.set(botId, list);
  };

  /** An acting call is running for this Bot, or one ended moments ago. */
  const mayDownload = (botId: string) => {
    const state = acting.get(botId);
    if (!state) return false;
    return state.running > 0 || now() - state.endedAt <= limits.graceMs;
  };

  /** The first free `Downloads/name`, numbering it like a desktop browser when it is taken. */
  const freePath = async (name: string): Promise<string> => {
    const extension = extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let copy = 0; copy < 100; copy += 1) {
      const candidate = `${DOWNLOADS_FOLDER}/${copy === 0 ? name : `${stem} (${copy})${extension}`}`;
      const exists = await workspace
        .resolvePath(candidate, false)
        .then(() => true)
        .catch(() => false);
      if (!exists) return candidate;
    }
    return `${DOWNLOADS_FOLDER}/${stem}-${Date.now()}${extension}`;
  };

  /*
   * Measures what is arriving in the browser's download folder, and cancels this Bot's downloads
   * once a file is past the limit. The partial files are not matched to downloads, so every one in
   * progress for the Bot is cancelled; one at a time is the ordinary case.
   */
  const watch = (botId: string) => {
    const directory = options.partialDir?.(botId);
    if (!directory || watchers.has(botId)) return;
    const timer = setInterval(() => {
      const current = arriving.get(botId);
      if (!current?.size) {
        clearInterval(timer);
        watchers.delete(botId);
        return;
      }
      void readdir(directory)
        .then(async (names) => {
          for (const name of names) {
            const size = (await stat(join(directory, name)).catch(() => null))
              ?.size;
            if (size !== undefined && size > limits.fileBytes) {
              for (const download of current) {
                current.delete(download);
                await download.cancel().catch(() => undefined);
              }
              refuse(
                botId,
                `A download grew past ${megabytes(limits.fileBytes)}, the most one file may be, and was cancelled.`,
              );
              return;
            }
          }
        })
        .catch(() => undefined);
    }, limits.watchMs);
    timer.unref?.();
    watchers.set(botId, timer);
  };

  const save = async (botId: string, download: Arriving): Promise<Outcome> => {
    const name = safeFileName(download.suggestedFilename());
    try {
      // Waits for the whole file, which the watch above keeps to the per-file limit.
      const partial = await download.path();
      const bytes = (await stat(partial)).size;
      if (bytes > limits.fileBytes)
        throw new Error(
          `it is ${megabytes(bytes)}, over the ${megabytes(limits.fileBytes)} a downloaded file may be`,
        );
      const folder = await workspace
        .resolvePath(DOWNLOADS_FOLDER, false)
        .catch(() => undefined);
      const held = folder ? await sizeOf(folder, limits.folderBytes) : 0;
      if (held + bytes > limits.folderBytes)
        throw new Error(
          `the ${DOWNLOADS_FOLDER} folder would pass its ${megabytes(limits.folderBytes)} limit; delete files from it first`,
        );
      const path = await freePath(name);
      const full = await workspace.resolvePath(path, true);
      await mkdir(dirname(full), { recursive: true });
      await download.saveAs(full);
      return { path, bytes: (await stat(full)).size };
    } catch (error) {
      return {
        name,
        failed: error instanceof Error ? error.message : String(error),
      };
    } finally {
      arriving.get(botId)?.delete(download);
      // The browser's own copy, in the partial folder: kept or refused, it is not needed now.
      await download.delete().catch(() => undefined);
    }
  };

  const receive = (botId: string, download: Arriving) => {
    if (!mayDownload(botId)) {
      void download.cancel().catch(() => undefined);
      refuse(
        botId,
        `The page started a download of ${safeFileName(download.suggestedFilename())} that none of your actions asked for, so it was cancelled.`,
      );
      return;
    }
    const set = arriving.get(botId) ?? new Set();
    set.add(download);
    arriving.set(botId, set);
    watch(botId);
    const list = inFlight.get(botId) ?? [];
    list.push(save(botId, download));
    inFlight.set(botId, list);
  };

  return {
    receive,
    limits,

    attach(botId: string, context: Pick<BrowserContext, "on">): void {
      if (attached.has(context)) return;
      attached.add(context);
      context.on("download", (download) => receive(botId, download));
    },

    /**
     * An acting call is running: downloads it starts, now or in the moments after it ends, are
     * accepted. Returns the call's end.
     */
    acting(botId: string): () => void {
      const state = acting.get(botId) ?? { running: 0, endedAt: 0 };
      state.running += 1;
      acting.set(botId, state);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        state.running = Math.max(0, state.running - 1);
        state.endedAt = now();
      };
    },

    /** Whether a download has started, or been refused, that no result has reported yet. */
    started(botId: string): boolean {
      return (
        (inFlight.get(botId)?.length ?? 0) > 0 ||
        (refusals.get(botId)?.length ?? 0) > 0
      );
    },

    /**
     * The downloads started since the last result, once saved (bounded by `waitMs`).
     *
     * The last saved one is the one reported; a refusal, a failure, or one still saving becomes a
     * note.
     */
    async take(
      botId: string,
      waitMs = DOWNLOAD_WAIT_MS,
    ): Promise<{ download?: SavedDownload; notes: string[] }> {
      const list = inFlight.get(botId) ?? [];
      inFlight.delete(botId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), waitMs);
      });
      const settled = await Promise.all(
        list.map((saving) => Promise.race([saving, late])),
      );
      clearTimeout(timer);
      const notes = [...(refusals.get(botId) ?? [])];
      refusals.delete(botId);
      let download: SavedDownload | undefined;
      for (const [index, outcome] of settled.entries()) {
        if (outcome === "late") {
          notes.push(
            `A download is still being saved into ${DOWNLOADS_FOLDER}/; list your files in a moment to find it.`,
          );
          // Still reported by the next result once it lands.
          const saving = list[index];
          if (saving) {
            const later = inFlight.get(botId) ?? [];
            later.push(saving);
            inFlight.set(botId, later);
          }
        } else if ("failed" in outcome)
          notes.push(
            `The download of ${outcome.name} was not kept: ${outcome.failed}.`,
          );
        else download = outcome;
      }
      return { ...(download ? { download } : {}), notes };
    },

    forget(botId: string): void {
      inFlight.delete(botId);
      arriving.delete(botId);
      refusals.delete(botId);
      const timer = watchers.get(botId);
      if (timer) clearInterval(timer);
      watchers.delete(botId);
      const directory = options.partialDir?.(botId);
      if (directory)
        void rm(directory, { recursive: true, force: true }).catch(
          () => undefined,
        );
    },
  };
}
