/**
 * A pool that has stopped answering is a dead server that still says it is alive.
 *
 * WHAT THIS IS FOR. On 2026-10-12 a Noë Bot deployment lost its Marketplace: every route that read
 * the database hung until the client gave up, while `/health`, the sign-in page and every 401
 * answered in a fifth of a second. Postgres showed the server's ten pooled connections idle, each
 * at the last query it had answered, and the runtime (Bun 1.3.14) never handed them out again: a
 * concurrent burst — the Agents tab's `/api/bot-templates` beside `/api/plugins` — leaked a few
 * connections per page load until none were left. Nothing restarted the process, because nothing
 * knew. The runtime was upgraded; this is what turns the next wedge, whatever causes it, into a
 * restart a minute later rather than an outage somebody has to notice.
 *
 * HOW IT DECIDES. Every `intervalMs` it runs a trivial query through the pool everybody shares. An
 * answer within `timeoutMs` is health. No answer is one of two things, and they must not be
 * confused: a database that is down (the pool is fine, there is nothing to reach, and exiting would
 * only crash-loop the container while Postgres is away), or a pool that will never answer again
 * while a connection of its own reaches the same database at once. Only the second is a wedge, and
 * only `strikes` wedged checks in a row call `onWedged` — one slow check under load is not a reason
 * to drop every request in flight.
 *
 * It runs on a timeout chain rather than an interval, so a check that is itself waiting on the
 * timeout never overlaps the next one, and the timer is unreferenced so it holds nothing open.
 */

export type PoolState = "unknown" | "ok" | "unreachable" | "wedged";

export type PoolWatchdogOptions = {
  /** A trivial query on the shared pool. */
  pooled: () => Promise<unknown>;
  /**
   * The same query on a connection of its own, opened and closed for the check, so a pool that has
   * stopped answering can be told from a database that nobody can reach.
   */
  fresh: () => Promise<unknown>;
  /** The pool is wedged. The caller exits so the supervisor starts a fresh process. */
  onWedged: (detail: { strikes: number }) => void;
  /** Between the start of one check and the next. */
  intervalMs?: number;
  /** How long a query may take before it counts as unanswered. */
  timeoutMs?: number;
  /** Consecutive wedged checks before `onWedged`. */
  strikes?: number;
  log?: (line: Record<string, unknown>) => void;
};

export type PoolWatchdog = {
  /** Runs one check now and answers with the state it found. */
  check: () => Promise<PoolState>;
  state: () => PoolState;
  stop: () => void;
};

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STRIKES = 2;

type Outcome = "answered" | "refused" | "silent";

/** What the query did before the deadline: answered, refused outright, or nothing at all. */
async function outcomeOf(
  query: () => Promise<unknown>,
  timeoutMs: number,
): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve("silent"), timeoutMs);
  });
  try {
    return await Promise.race([
      query().then(
        (): Outcome => "answered",
        (): Outcome => "refused",
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function startPoolWatchdog(options: PoolWatchdogOptions): PoolWatchdog {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.strikes ?? DEFAULT_STRIKES;
  const log = options.log ?? (() => {});

  let state: PoolState = "unknown";
  let strikes = 0;
  let unreachableLogged = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function unreachable(reason: string): PoolState {
    state = "unreachable";
    strikes = 0;
    // Once per outage, not once per check: a database away for an hour is one line, not 240.
    if (!unreachableLogged) {
      unreachableLogged = true;
      log({ type: "database-unreachable", reason, timeoutMs });
    }
    return state;
  }

  async function check(): Promise<PoolState> {
    const pooled = await outcomeOf(options.pooled, timeoutMs);
    if (pooled === "answered") {
      if (state === "unreachable") log({ type: "database-reachable-again" });
      state = "ok";
      strikes = 0;
      unreachableLogged = false;
      return state;
    }
    // A refusal is an answer: the pool is alive and the database said no. Not a wedge.
    if (pooled === "refused") return unreachable("the pooled query was refused");
    // Only a pool that says nothing while a connection of its own gets through is wedged.
    if ((await outcomeOf(options.fresh, timeoutMs)) !== "answered") {
      return unreachable("a fresh connection did not answer either");
    }
    state = "wedged";
    strikes += 1;
    log({ type: "database-pool-wedged", strikes, limit, timeoutMs });
    if (strikes >= limit) options.onWedged({ strikes });
    return state;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      void check().finally(schedule);
    }, intervalMs);
    // Node and Bun timers hold the event loop open; a browser-shaped timer has no such method.
    (timer as { unref?: () => void }).unref?.();
  }
  schedule();

  return {
    check,
    state: () => state,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
