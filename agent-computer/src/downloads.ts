/**
 * Files a page downloads, saved into the Bot's workspace.
 *
 * A Bot asked for a statement clicked "Download PDF" and the file went nowhere it could reach:
 * Playwright keeps downloads in a temporary folder that is deleted with the browser. Now every
 * download is saved under `Downloads/` in the workspace, through the same path guards the file tools
 * use, and the action that started it answers with `page.download` (where, and how big), so the Bot
 * can read it, send it or upload it elsewhere.
 *
 * Playwright types only; the workspace is passed in, so a test can give it a temporary one.
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type { BrowserContext, Download } from "playwright";

export type SavedDownload = { path: string; bytes: number };

type Outcome = SavedDownload | { failed: string; name: string };

/** The folder downloads land in, relative to the workspace root. */
export const DOWNLOADS_FOLDER = "Downloads";

/** How long an action waits for a download it started to finish saving. */
export const DOWNLOAD_WAIT_MS = 20_000;

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

export type DownloadKeeper = ReturnType<typeof createDownloadKeeper>;

export function createDownloadKeeper(workspace: {
  resolvePath(requested: string, forWrite: boolean): Promise<string>;
}) {
  const inFlight = new Map<string, Promise<Outcome>[]>();
  const attached = new WeakSet<object>();

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

  const save = async (
    download: Pick<Download, "suggestedFilename" | "saveAs">,
  ): Promise<Outcome> => {
    const name = safeFileName(download.suggestedFilename());
    try {
      const path = await freePath(name);
      const full = await workspace.resolvePath(path, true);
      await mkdir(dirname(full), { recursive: true });
      await download.saveAs(full);
      const { size } = await stat(full);
      return { path, bytes: size };
    } catch (error) {
      return {
        name,
        failed: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const receive = (
    botId: string,
    download: Pick<Download, "suggestedFilename" | "saveAs">,
  ) => {
    const list = inFlight.get(botId) ?? [];
    list.push(save(download));
    inFlight.set(botId, list);
  };

  return {
    receive,

    attach(botId: string, context: Pick<BrowserContext, "on">): void {
      if (attached.has(context)) return;
      attached.add(context);
      context.on("download", (download) => receive(botId, download));
    },

    /** Whether a download has started that no result has reported yet. */
    started(botId: string): boolean {
      return (inFlight.get(botId)?.length ?? 0) > 0;
    },

    /**
     * The downloads started since the last result, once saved (bounded by `waitMs`).
     *
     * The last saved one is the one reported; a failure, or one still saving, becomes a note.
     */
    async take(
      botId: string,
      waitMs = DOWNLOAD_WAIT_MS,
    ): Promise<{ download?: SavedDownload; notes: string[] }> {
      const list = inFlight.get(botId);
      if (!list?.length) return { notes: [] };
      inFlight.delete(botId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), waitMs);
      });
      const settled = await Promise.all(
        list.map((saving) => Promise.race([saving, late])),
      );
      clearTimeout(timer);
      const notes: string[] = [];
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
            `The download of ${outcome.name} failed: ${outcome.failed}`,
          );
        else download = outcome;
      }
      return { ...(download ? { download } : {}), notes };
    },

    forget(botId: string): void {
      inFlight.delete(botId);
    },
  };
}
