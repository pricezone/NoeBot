import { IconPlayerRecordFilled } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useComputerControl } from "@/lib/computers/use-control";
import {
  demonstrationsQueryOptions,
  startDemonstration,
  stopDemonstration,
  UNTITLED_WORKFLOW,
} from "@/lib/demonstrations";
import {
  clock,
  refreshDemonstrations,
  useSecondsLeft,
  WorkflowDialog,
} from "./demonstration-recorder";

/**
 * Record your steps, in the screen viewer's top bar.
 *
 * One press: a person who is not already driving takes control first, because a recording is what
 * a person does while holding the wheel, and recording starts under a placeholder title the start
 * route requires. The workflow is named afterwards, once its steps exist — on stop, or when the
 * server stops it at ten minutes, "Name this workflow" opens and carries on into the skill review.
 *
 * `onRecordingChange` reconnects the stream whenever a recording starts or ends: the server attaches
 * the recording to the stream when it connects, so a stream opened before the recording started
 * would record nothing, and one left open after it stopped would keep carrying its id.
 */
export function RecordStepsButton({
  botId,
  driving,
  onRecordingChange,
  onDialogOpenChange,
}: {
  botId: string;
  driving: boolean;
  onRecordingChange: () => void;
  /** Told while "Name this workflow" is open, so Escape there does not also close the viewer. */
  onDialogOpenChange?: (open: boolean) => void;
}) {
  const recordings = useQuery(demonstrationsQueryOptions(botId));
  const active = recordings.data?.find(
    (recording) => recording.status === "recording",
  );
  const secondsLeft = useSecondsLeft(active?.expiresAt);
  const { control, busy, change } = useComputerControl(botId);
  /** Taking control first is only possible when Take control itself is. */
  const cannotTake = !driving && (busy || !control || control.transitioning);
  /** The recording being named and reviewed, once it has stopped. */
  const [naming, setNaming] = useState<string | null>(null);

  useEffect(() => {
    onDialogOpenChange?.(naming !== null);
  }, [naming, onDialogOpenChange]);

  /*
   * The server stops a recording at ten minutes, and at 200 steps. When the active recording is gone
   * — stopped here or there — reconnect the stream so it stops carrying the recording id, and ask
   * for the workflow's name.
   */
  const wasActive = useRef<string | undefined>(undefined);
  useEffect(() => {
    const stopped = wasActive.current;
    wasActive.current = active?.id;
    if (stopped && !active) {
      onRecordingChange();
      setNaming(stopped);
    }
  }, [active, onRecordingChange]);
  useEffect(() => {
    if (secondsLeft === 0) void refreshDemonstrations(botId);
  }, [secondsLeft, botId]);

  const start = useMutation({
    mutationFn: async () => {
      // A failed takeover says why on Take control, from the same shared store.
      if (!driving && !(await change?.("take"))) return null;
      return startDemonstration(botId, UNTITLED_WORKFLOW);
    },
    onSuccess: async (started) => {
      if (!started) return;
      await refreshDemonstrations(botId);
      onRecordingChange();
    },
  });
  const stop = useMutation({
    mutationFn: (recordingId: string) => stopDemonstration(recordingId),
    onSuccess: async (_response, recordingId) => {
      await refreshDemonstrations(botId);
      // The effect above normally opens it as the list catches up; this covers a slow list.
      setNaming(recordingId);
    },
  });
  const problem = start.error ?? stop.error;
  const steps = active?.actions.length ?? 0;

  return (
    <div className="relative flex items-center gap-2">
      {active ? (
        <>
          <span className="flex items-center gap-2 text-[13px] tabular-nums">
            <span
              aria-hidden="true"
              className="size-2 animate-pulse rounded-full bg-red-500"
            />
            <span className="sr-only">Recording.</span>
            {secondsLeft !== null ? (
              <span
                aria-live={secondsLeft <= 60 ? "polite" : "off"}
                className={secondsLeft <= 60 ? "font-medium text-red-400" : ""}
              >
                {secondsLeft > 0
                  ? `${clock(secondsLeft)} left`
                  : "Time limit reached. Stopping…"}
              </span>
            ) : null}
            <span className="opacity-70">
              {steps} {steps === 1 ? "step" : "steps"}
            </span>
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={stop.isPending}
            onClick={() => stop.mutate(active.id)}
          >
            Stop recording
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={start.isPending || cannotTake}
          onClick={() => start.mutate()}
        >
          <IconPlayerRecordFilled className="text-red-500" />
          Record your steps
        </Button>
      )}
      {problem ? (
        <span
          className="absolute top-full right-0 mt-1 w-64 rounded-md bg-background px-2 py-1 text-xs text-destructive shadow-sm"
          role="alert"
        >
          {problem.message}
        </span>
      ) : null}
      {naming ? (
        <WorkflowDialog
          botId={botId}
          recordingId={naming}
          onClose={() => setNaming(null)}
        />
      ) : null}
    </div>
  );
}
