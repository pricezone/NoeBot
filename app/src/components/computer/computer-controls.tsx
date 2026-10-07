import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useComputerControl } from "@/lib/computers/use-control";

/**
 * The same ownership action appears in the screen card's footer and in the full-window viewer.
 *
 * It used to sit in the chat header as well, beside a "Computer" toggle. The header now carries
 * only the Bot pill and the panel toggle; the wheel lives with the screen it steers, and the panel
 * opens itself when the Bot needs somebody (`lib/computers/attention.ts`).
 *
 * `withTooltip` is the viewer's top bar, where Take control sits beside Record your steps: hovering
 * it says what the two together are for. There the viewer's own status pill says that the current
 * action is finishing, so this does not say it a second time, and a problem hangs below the button
 * rather than stretching the bar.
 */
export function ComputerControlButton({
  computerId,
  onTakeControl,
  withTooltip = false,
}: {
  computerId: string;
  onTakeControl?: () => void;
  withTooltip?: boolean;
}) {
  const { control, busy, problem, change } = useComputerControl(computerId);
  const human = control?.holder === "human";
  const button = (
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
  );
  if (withTooltip)
    return (
      <div className="relative">
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipContent
            className="max-w-sm flex-col items-start text-left"
            side="bottom"
          >
            <span className="font-semibold">Teach a browser workflow</span>
            <span>
              Take control, record the steps, then review a skill draft. Typed
              values and images are omitted. Sensitive fields stay in your
              hands. Recording stops automatically after ten minutes.
            </span>
          </TooltipContent>
        </Tooltip>
        {problem ? (
          <span
            className="absolute top-full right-0 mt-1 w-64 rounded-md bg-background px-2 py-1 text-xs text-destructive shadow-sm"
            role="alert"
          >
            {problem}
          </span>
        ) : null}
      </div>
    );
  return (
    <div className="flex flex-col items-start gap-1">
      {button}
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
