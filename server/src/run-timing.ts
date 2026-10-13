import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where one run's time goes, measured phase by phase.
 *
 * A browser step cost eight to ten seconds and nothing said which part: the agent build, the
 * Learning lookup, the thread, the lock, the history read, the model or the computer. Each of those
 * is timed where it happens and collected here, keyed by the conversation, because the two halves of
 * a run happen in different places. The request half (build, Learning, thread, lock, history) runs
 * inside the HTTP request and is also answered as a `Server-Timing` header; the run half (model and
 * tools) runs after the response, in the runner, and ends in one structured line per run:
 *
 *   [timing] run=… thread=… total=… phases=agent_build:12,learning:80,…,model.ttft:640,…
 *
 * Measurement only. Nothing here may throw into a run or change what it does.
 */

export type TimingPhase = { name: string; ms: number };

export type RunTiming = {
  threadId?: string;
  runId?: string;
  startedAt: number;
  phases: TimingPhase[];
};

const requestTiming = new AsyncLocalStorage<RunTiming>();
/** Request halves waiting for their run, by thread. A thread runs one run at a time. */
const pending = new Map<string, RunTiming>();
/** Runs in progress, by thread, so a tool or a model step can add to the right one. */
const active = new Map<string, RunTiming>();
/** A request half no run ever claimed (a remote Bot, a failed start) is dropped after this. */
const PENDING_TTL_MS = 120_000;

export const now = () => performance.now();

export function newRunTiming(): RunTiming {
  return { startedAt: now(), phases: [] };
}

/** Run `work` with `timing` as the request half that phases are recorded into. */
export function withRequestTiming<T>(timing: RunTiming, work: () => T): T {
  return requestTiming.run(timing, work);
}

function prune() {
  const cutoff = now() - PENDING_TTL_MS;
  for (const [threadId, timing] of pending)
    if (timing.startedAt < cutoff) pending.delete(threadId);
}

/**
 * Add one measured phase.
 *
 * To the current request when there is one, which the thread id then names so the run that request
 * starts can claim it; otherwise to the run in progress on `threadId`. The request comes first so a
 * history read by some other request never lands in a run it has nothing to do with.
 */
export function recordPhase(name: string, ms: number, threadId?: string) {
  try {
    const phase = { name, ms: Math.max(0, Math.round(ms)) };
    const request = requestTiming.getStore();
    if (request) {
      request.phases.push(phase);
      if (threadId && request.threadId !== threadId) {
        request.threadId = threadId;
        prune();
        pending.set(threadId, request);
      }
      return;
    }
    const running = threadId ? active.get(threadId) : undefined;
    running?.phases.push(phase);
  } catch {
    // Measurement never fails a run.
  }
}

/** Time an asynchronous phase. The work's own outcome, success or failure, is passed through. */
export async function timed<T>(
  name: string,
  work: () => Promise<T>,
  threadId?: string,
): Promise<T> {
  const started = now();
  try {
    return await work();
  } finally {
    recordPhase(name, now() - started, threadId);
  }
}

/** A run started on this thread: it takes over the request half its request measured. */
export function beginRunTiming(threadId: string, runId: string): RunTiming {
  const claimed = pending.get(threadId);
  pending.delete(threadId);
  const timing = claimed ?? newRunTiming();
  timing.threadId = threadId;
  timing.runId = runId;
  active.set(threadId, timing);
  return timing;
}

/** The run is over: its line is written once, and the thread is free for the next run's timing. */
export function endRunTiming(
  timing: RunTiming,
  log: (line: string) => void = (line) => console.info(line),
) {
  if (active.get(timing.threadId ?? "") === timing)
    active.delete(timing.threadId ?? "");
  try {
    log(formatTimingLine(timing));
  } catch {
    // A log line that cannot be written is not a failed run.
  }
}

/** The structured line: the run, the thread, the whole, and every phase in the order measured. */
export function formatTimingLine(timing: RunTiming): string {
  const total = Math.round(now() - timing.startedAt);
  const phases = timing.phases
    .map((phase) => `${phase.name}:${phase.ms}`)
    .join(",");
  return `[timing] run=${timing.runId ?? "-"} thread=${timing.threadId ?? "-"} total=${total} phases=${phases}`;
}

/**
 * The request half as a `Server-Timing` header value, or undefined when nothing was measured.
 *
 * Repeated phases are summed, so the header names each phase once. Names are already tokens.
 */
export function serverTimingHeader(timing: RunTiming): string | undefined {
  if (timing.phases.length === 0) return undefined;
  const totals = new Map<string, number>();
  for (const phase of timing.phases)
    totals.set(phase.name, (totals.get(phase.name) ?? 0) + phase.ms);
  return [...totals]
    .map(([name, ms]) => `${name.replace(/[^\w.-]/g, "_")};dur=${ms}`)
    .join(", ");
}

/** The paths whose requests are timed: the runtime's, where a run is started. */
const TIMED_PATH = "/api/copilotkit";

/**
 * Handle one HTTP request, timing it when it is a runtime request and answering what was measured
 * as a `Server-Timing` header. Every other request is passed straight through.
 */
export async function timedFetch(
  request: Request,
  handle: () => Response | Promise<Response>,
): Promise<Response> {
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return handle();
  }
  if (!path.startsWith(TIMED_PATH)) return handle();
  const timing = newRunTiming();
  const response = await withRequestTiming(timing, handle);
  const header = serverTimingHeader(timing);
  if (!header || !response) return response;
  try {
    response.headers.append("Server-Timing", header);
    return response;
  } catch {
    // Immutable headers: answer the same body with a copy that can carry the header.
    const headers = new Headers(response.headers);
    headers.append("Server-Timing", header);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** For tests: forget every pending and active timing. */
export function resetRunTimingForTests() {
  pending.clear();
  active.clear();
}
