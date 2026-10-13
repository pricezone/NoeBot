import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RecoveryCard } from "@/components/chat-cards/recovery-card";
import { readControl } from "@/lib/computers/control";
import {
  forgetHandoff,
  hasActiveHandoff,
  type PendingHandoff,
  pendingHandoff,
  rememberHandoff,
} from "@/lib/computers/handoff";
import {
  findPendingTool,
  type HandoffAgent,
  resumeHandoffTask,
} from "@/lib/copilot/handoff-resume";
import { useUiStrings } from "@/lib/i18n/strings";

/**
 * A browser task paused on a handoff, resumed from the step it paused at.
 *
 * SDK reconnect replays human-in-the-loop tools only; ordinary frontend handlers need this action.
 *
 * IN THE TRANSCRIPT, AT THE PAUSED STEP. This used to be an amber strip above the composer, which
 * put "a task is paused" in a different part of the screen from the step that paused, and gave it
 * underlined text for buttons. Now `HandoffResumeNotice` (mounted where it always was, beside the
 * agent it watches) only works out whether a task is paused and publishes it; the transcript draws
 * `PausedTaskCard` beside the tool call that is waiting, a RecoveryCard with Resume, or Stop waiting
 * while it waits. A paused call the transcript does not draw is shown at its end instead
 * (`PausedTaskFallback`), so a task can never be paused where nobody can see it.
 */

type PausedTask = {
  /** The tool call that paused, when it is known; the card is drawn beside it. */
  toolCallId: string | null;
  waiting: boolean;
  problem: string | null;
  /** Resume is offered only when nothing is running and the handoff is still there to resume. */
  canResume: boolean;
  resume: () => void;
  stopWaiting: () => void;
};

/** What every mounted notice has published, by the bot it watches. One channel at a time, in practice. */
const published = new Map<string, PausedTask>();
const listeners = new Set<() => void>();
let snapshot: readonly PausedTask[] = [];

function publish(botId: string, task: PausedTask | null) {
  if (task) published.set(botId, task);
  else if (!published.delete(botId)) return;
  snapshot = [...published.values()];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const NONE: readonly PausedTask[] = [];

function usePausedTasks(): readonly PausedTask[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => NONE,
  );
}

/** Watches for a paused handoff in this conversation and publishes it; draws nothing itself. */
export function HandoffResumeNotice({
  botId,
  agent,
  ready,
  run,
}: {
  botId: string;
  agent: HandoffAgent;
  ready: boolean;
  run: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState<PendingHandoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  /** The step that paused, kept past `pending` so a failed resume is still drawn beside it. */
  const lastToolCallId = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      let stored = pendingHandoff(botId);
      if (!stored) {
        const state = await readControl(botId).catch(() => null);
        const request = state?.request;
        if (request?.toolCallId) {
          const candidate = {
            requestId: request.id,
            toolCallId: request.toolCallId,
          };
          if (findPendingTool(agent.messages, candidate)) {
            rememberHandoff(botId, candidate.requestId, candidate.toolCallId);
            stored = candidate;
          }
        }
      }
      if (!live) return;
      if (stored && !findPendingTool(agent.messages, stored)) {
        const toolCallId = stored.toolCallId;
        const answered = agent.messages.some(
          (m) => m.role === "tool" && m.toolCallId === toolCallId,
        );
        if (answered) forgetHandoff(botId, stored.requestId);
        stored = null;
      }
      setPending(
        stored && !hasActiveHandoff(botId, stored.requestId) ? stored : null,
      );
      timer = setTimeout(() => void check(), 1000);
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
      controller.current?.abort("detached");
    };
  }, [botId, agent, ready]);

  const resumeRef = useRef<() => Promise<void>>(async () => undefined);
  resumeRef.current = async () => {
    if (!pending || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setProblem(null);
    try {
      await resumeHandoffTask(botId, pending, agent, run, abort.signal);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "The task could not resume.",
      );
    } finally {
      setBusy(false);
      controller.current = null;
    }
  };

  if (pending) lastToolCallId.current = pending.toolCallId;
  const shown = Boolean(pending || busy || problem);
  const toolCallId = pending?.toolCallId ?? lastToolCallId.current;
  const canResume = Boolean(pending) && !agent.isRunning;
  useEffect(() => {
    publish(
      botId,
      shown
        ? {
            toolCallId,
            waiting: busy,
            problem,
            canResume,
            resume: () => void resumeRef.current(),
            stopWaiting: () => controller.current?.abort(),
          }
        : null,
    );
  }, [botId, shown, toolCallId, busy, problem, canResume]);
  useEffect(() => () => publish(botId, null), [botId]);
  return null;
}

/** The card itself: Resume while paused, Stop waiting while the handoff is being waited on. */
function PausedTaskRecovery({ task }: { task: PausedTask }) {
  const ui = useUiStrings();
  return (
    <RecoveryCard
      compact
      detail={task.problem ? undefined : ui.pausedTaskDetail}
      testId="paused-task"
      title={task.problem ?? (task.waiting ? ui.pausedWaiting : ui.pausedTask)}
      tone={task.problem ? "error" : "paused"}
      {...(task.waiting
        ? { onStopWaiting: task.stopWaiting }
        : { onResume: task.resume, disabled: !task.canResume })}
    />
  );
}

/** Beside a drawn step: the paused task, if it paused at one of these tool calls. */
export function PausedTaskCard({
  toolCallIds,
}: {
  toolCallIds: readonly string[];
}) {
  const tasks = usePausedTasks();
  const task = tasks.find(
    (candidate) =>
      candidate.toolCallId !== null &&
      toolCallIds.includes(candidate.toolCallId),
  );
  return task ? <PausedTaskRecovery task={task} /> : null;
}

/** At the end of the transcript: a paused task whose step is not drawn (or is unknown). */
export function PausedTaskFallback({ drawn }: { drawn: ReadonlySet<string> }) {
  const tasks = usePausedTasks();
  const task = tasks.find(
    (candidate) =>
      candidate.toolCallId === null || !drawn.has(candidate.toolCallId),
  );
  return task ? <PausedTaskRecovery task={task} /> : null;
}
