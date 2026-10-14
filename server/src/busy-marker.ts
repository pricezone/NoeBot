import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Tells the server this app runs on that a turn is in progress, so an automatic update waits.
 *
 * HyperNoesis's agent on the VPS switches to a new image once an hour, and doing that stopped a
 * person's turn in the middle (the gov.gr run, 2026-10-14 01:14). While any run is going, and for a
 * grace minute after the last one ends (a browser turn is several runs with short gaps), this keeps
 * a file in the app's data folder fresh; the agent reads the folder from the host and holds the
 * switch while the file is younger than 90 seconds. A crashed process leaves a stale file the agent
 * ignores, so nothing can hold an update for ever.
 *
 * A file, not an endpoint: the data folder is already shared with the host, and an endpoint on the
 * app's port would also be reachable through the public proxy.
 */

/**
 * A folder of its own, made writable for the API's user by the entrypoint (the data folder's root
 * belongs to root), with one file per process: the API and the worker both run Bots, and one
 * finishing must not delete the other's marker. The agent treats any fresh `busy-*` file as busy.
 */
export const BUSY_DIR_NAME = ".hypernoesis";
const REFRESH_MS = 20_000;
const GRACE_MS = 60_000;

export type BusyMarker = {
  /** A run began; call the returned function when it ends. */
  runStarted(): () => void;
  /** For tests: how many runs are open. */
  open(): number;
  stop(): void;
};

export function createBusyMarker({
  path,
  now = Date.now,
  write = (file: string, body: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  },
  remove = (file: string) => rmSync(file, { force: true }),
  setTimer = (fn: () => void, ms: number) => setInterval(fn, ms),
  clearTimer = (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
}: {
  path: string | null;
  now?: () => number;
  write?: (file: string, body: string) => void;
  remove?: (file: string) => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
}): BusyMarker {
  let runs = 0;
  let lastEnded = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const safely = (work: () => void) => {
    try {
      work();
    } catch {
      // A marker that cannot be written only means an update may not wait; never fail a run for it.
    }
  };
  const refresh = () => {
    if (!path) return;
    if (runs === 0 && now() - lastEnded >= GRACE_MS) {
      safely(() => remove(path));
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      return;
    }
    safely(() =>
      write(
        path,
        `${JSON.stringify({ runs, at: new Date(now()).toISOString() })}\n`,
      ),
    );
  };

  return {
    runStarted() {
      runs += 1;
      refresh();
      if (path && timer === undefined) timer = setTimer(refresh, REFRESH_MS);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        runs = Math.max(0, runs - 1);
        lastEnded = now();
        refresh();
      };
    },
    open: () => runs,
    stop() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      if (path) safely(() => remove(path));
    },
  };
}

/**
 * Where this process's marker goes: `HYPERNOESIS_BUSY_FILE`, else `.hypernoesis/busy-<pid>` in the
 * data folder (`OPENBOT_DATA_DIR`, else `/data` when it exists, which is how the image runs on a
 * VPS). Nowhere in development.
 */
export function busyFilePath(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): string | null {
  if (env.HYPERNOESIS_BUSY_FILE) return env.HYPERNOESIS_BUSY_FILE;
  const dir =
    env.OPENBOT_DATA_DIR ?? (existsSync("/data") ? "/data" : undefined);
  return dir ? join(dir, BUSY_DIR_NAME, `busy-${pid}`) : null;
}

/** The process's one marker, shared by every run. */
export const busyMarker = createBusyMarker({ path: busyFilePath() });
