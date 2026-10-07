/**
 * Which entries under the profiles root are Bots.
 *
 * ITS OWN MODULE SO ONE ANSWER SERVES BOTH SIDES. The rule lived inline in `profiles.ts`, and the
 * test that covered it had a second copy: delete the production filter and the suite stayed green,
 * because it was checking its own copy rather than the shipped one. A predicate worth testing is
 * worth importing.
 *
 * Free of Playwright on purpose. `profiles.ts` launches browsers, so a test that wanted this rule had
 * to drag a browser runtime in with it, which is most of why the copy existed in the first place.
 */
import { readFile, readlink, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { isPlainBotId } from "./bot-id";

/** The shape of a directory entry, as both `readdir` and a test can supply it. */
export type ProfileEntry = { name: string; isDirectory: () => boolean };

/**
 * The Bot ids among a directory listing, sorted and deduplicated.
 *
 * ONLY ENTRIES THIS CODE COULD HAVE MADE. The root is a mounted volume, and a volume is not an empty
 * directory: a real disk formatted ext4 arrives with `lost+found` already in it, so on a cloud the
 * fleet page listed a Bot by that name, offered to reset it, and nobody could say where it came from.
 * Never seen locally, because a bind mount and kind's local-path volumes have no such directory,
 * which is exactly the shape of bug that ships.
 *
 * `isPlainBotId` is the same allow-list that stops a hostile id becoming a path, used here for the
 * other half of the question: an entry it would refuse to create is not one of ours to list.
 */
export function botIdsIn(entries: readonly ProfileEntry[]): string[] {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => isPlainBotId(entry.name))
        .map((entry) => entry.name),
    ),
  ].sort();
}

/**
 * The Bot whose browser was used last, among `botIds` under `root`; null when none has been opened.
 *
 * Chromium rewrites `Local State` while it runs, so its time is the last time that Bot's browser was
 * open. A profile without one was made and never opened, and is never the answer.
 */
export async function lastUsedProfile(
  root: string,
  botIds: readonly string[],
): Promise<string | null> {
  let newest: { botId: string; at: number } | null = null;
  for (const botId of botIds) {
    if (!isPlainBotId(botId)) continue;
    const at = await stat(join(root, botId, "Local State")).then(
      (info) => info.mtimeMs,
      () => 0,
    );
    if (at > 0 && (!newest || at > newest.at)) newest = { botId, at };
  }
  return newest?.botId ?? null;
}

/**
 * Whether the Chromium that owns this profile is still running, read from the profile itself.
 *
 * Chromium keeps a `SingletonLock` symlink in its profile whose target is `<host>-<pid>`, removes it
 * on a clean exit, and leaves it pointing at a dead pid after a crash. So: no lock, a lock from
 * another host, or a pid that is not running all mean the browser is gone.
 *
 * WHY THIS EXISTS. Playwright did not always notice. On the live instance a browser exited and
 * Playwright went on reporting it connected; every request then waited on a page nobody would ever
 * answer, and the dock's Chrome button stopped working until the machine restarted. The process is
 * the ground truth, and asking for it costs one readlink and one signal 0.
 */
export async function browserProcessAlive(
  profileDir: string,
  {
    host = hostname(),
    isRunning = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM: it exists and belongs to someone else, which still means it is running.
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  }: { host?: string; isRunning?: (pid: number) => boolean } = {},
): Promise<boolean> {
  const target = await readlink(join(profileDir, "SingletonLock")).catch(
    () => null,
  );
  if (!target) return false;
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match) return false;
  const [, owner, pid] = match;
  if (owner !== host) return false;
  return isRunning(Number(pid));
}

/**
 * The last warnings Chromium wrote to `chrome_debug.log` in its profile (it is launched with
 * `--enable-logging --log-level=1`), for the line that says a browser has gone. Empty when there is
 * no log. Short and cut, because it goes into the deployment's log.
 */
export async function chromiumLogTail(
  profileDir: string,
  lines = 15,
): Promise<string[]> {
  const text = await readFile(
    join(profileDir, "chrome_debug.log"),
    "utf8",
  ).catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .slice(-lines)
    .map((line) => line.slice(0, 300));
}
