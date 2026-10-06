import { Button } from "@/components/ui/button";
import { useComputerControl } from "@/lib/computers/use-control";

/**
 * The same ownership action appears in the screen card's footer and in the full-size viewer.
 *
 * It used to sit in the chat header as well, beside a "Computer" toggle. The header now carries
 * only the Bot pill and the panel toggle; the wheel lives with the screen it steers, and the panel
 * opens itself when the Bot needs somebody (`lib/computers/attention.ts`).
 */
export function ComputerControlButton({
  computerId,
  onTakeControl,
}: {
  computerId: string;
  onTakeControl?: () => void;
}) {
  const { control, busy, problem, change } = useComputerControl(computerId);
  const human = control?.holder === "human";
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant={human ? "default" : "outline"}
        disabled={busy || !control || control.transitioning}
        aria-busy={busy || control?.transitioning}
        onClick={async () => {
          if (await change?.(human ? "release" : "take")) {
            if (!human) onTakeControl?.();
          }
        }}
      >
        {human ? "Hand back" : "Take control"}
      </Button>
      {control?.transitioning ? (
        <span className="text-xs text-muted-foreground" role="status">
          Finishing the current action…
        </span>
      ) : null}
      {problem ? (
        <span className="max-w-64 text-xs text-destructive" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}
