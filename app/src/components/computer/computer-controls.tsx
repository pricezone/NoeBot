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
 *
 * THERE IS NO "HAND BACK" WHILE THE PERSON HOLDS THE WHEEL. Minimizing the viewer hands control
 * back (`ComputerView`'s `minimize`), so the viewer's button becomes "Keep control" instead: a
 * toggle, off by default, for somebody who wants to put the screen away and still hold it. Its state belongs to the viewer and comes in as `keepControl`,
 * because what it decides is what minimizing does. The card has no minimize of its own, so there
 * the button opens the viewer (`onOpenScreen`), which is where control is handed back.
 */
export function ComputerControlButton({
  computerId,
  onTakeControl,
  withTooltip = false,
  keepControl = false,
  onKeepControlChange,
  onOpenScreen,
}: {
  computerId: string;
  onTakeControl?: () => void;
  withTooltip?: boolean;
  /** Whether "Keep control" is switched on. Only drawn while the person holds control. */
  keepControl?: boolean;
  onKeepControlChange?: (keep: boolean) => void;
  /**
   * Given by a surface without a minimize of its own: while the person holds control the button
   * reads "Open screen" and opens the viewer, rather than offering a toggle that would decide
   * nothing there.
   */
  onOpenScreen?: () => void;
}) {
  const { control, busy, problem, change } = useComputerControl(computerId);
  const human = control?.holder === "human";
  const disabled = busy || !control || control.transitioning;
  const button = !human ? (
    <Button
      size="sm"
      variant="outline"
      // The viewer's bar sets white text on everything in it, and outline is white in light mode.
      className="text-foreground"
      disabled={disabled}
      aria-busy={busy || control?.transitioning}
      onClick={async () => {
        if (await change?.("take")) onTakeControl?.();
      }}
    >
      Take control
    </Button>
  ) : onOpenScreen ? (
    <Button size="sm" onClick={onOpenScreen}>
      Open screen
    </Button>
  ) : (
    <Button
      size="sm"
      variant={keepControl ? "default" : "outline"}
      className={keepControl ? undefined : "text-foreground"}
      aria-pressed={keepControl}
      disabled={disabled}
      aria-busy={busy || control?.transitioning}
      onClick={() => onKeepControlChange?.(!keepControl)}
    >
      Keep control
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
