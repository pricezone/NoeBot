import { open, opendir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Read every file under `dir` once and throw the bytes away, so the next reader finds them in the
 * operating system's page cache.
 *
 * For the browser's installation at boot. A machine that has just started reads Chromium's few
 * hundred megabytes from disk on its first launch, and that read is most of the launch: on a Fly
 * instance the first browser after a restart took 11.5 s, and 0.7 s once these files had been read
 * (2026-10-07). Done in the background while nothing is waiting, it moves that cost to where nobody
 * sees it. Sequential and one buffer, so it borrows the disk rather than taking it over.
 */
export async function readThrough(
  dir: string,
): Promise<{ files: number; bytes: number }> {
  const buffer = Buffer.allocUnsafe(1 << 20);
  let files = 0;
  let bytes = 0;
  const walk = async (path: string): Promise<void> => {
    for await (const entry of await opendir(path)) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      // Skipped, not fatal: the install carries packaging files this user may not read
      // (`rpm.deps`, measured), and the browser never opens those either.
      const handle = await open(full, "r").catch(() => null);
      if (!handle) continue;
      try {
        for (;;) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (bytesRead === 0) break;
          bytes += bytesRead;
        }
      } finally {
        await handle.close();
      }
      files++;
    }
  };
  await walk(dir);
  return { files, bytes };
}
