import { IconArrowsMinimize } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { agentQueryOptions } from "@/lib/agents/queries";
import { brand } from "@/lib/brand";
import type { ControlState } from "@/lib/computers/control";
import { ComputerControlButton } from "./computer-controls";
import { LiveScreen } from "./live-screen";
import { RecordStepsButton } from "./record-steps-button";

/** The part of a URL worth putting on screen; the whole thing is rarely readable at this size. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The data URL for a frame, which is a PNG of a page or a JPEG of a desktop. */
export function frameSource(frame: {
  base64: string;
  format?: string;
}): string {
  return `data:image/${frame.format === "jpeg" ? "jpeg" : "png"};base64,${frame.base64}`;
}

/**
 * What the frame says when there is no picture in it.
 *
 * Shared by the card and the full-window viewer because it is the same fact at either size, and
 * because the viewer is reachable with nothing to draw: the wheel lives up there, so a person whose
 * Bot is looking at a blank browser — or whose screen cannot be read at all — has to be able to
 * open it and be told why it is empty, rather than find a disabled frame and no way in.
 */
export function NothingToSee({
  problem,
  blankBrowser,
  settled,
  page,
}: {
  problem: string | null;
  blankBrowser: boolean;
  /** Whether this is a turn that has finished, rather than the browser as it is now. */
  settled?: boolean;
  /** The page that turn opened, named when there is no picture of it. */
  page?: { url?: string; title?: string } | undefined;
}) {
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-muted-foreground text-sm">
      {settled ? (
        <>
          {/*
            What this turn had open, named rather than drawn.

            The picture is gone: nothing stored it, and fetching one now would show a different page.
            Naming the page is the honest version of the same sentence, and it stays true however
            many times the Bot has browsed since.

            GATED ON THE TURN BEING OVER, not on whether a live frame happens to be in hand. A tile
            that was live a moment ago keeps its last screenshot in state after it settles, and this
            used to check for that: with one held and no frame stored, it fell through to "Waiting
            for the assistant's screen…" and waited there for ever, because the poll that would have
            ended the wait stops the moment a turn settles.
          */}
          {page?.url ? (
            <>
              <span className="font-medium">{page.title || "A page"}</span>
              <span className="break-all">{hostOf(page.url)}</span>
              <span>
                Opened during this turn. The screen has moved on since.
              </span>
            </>
          ) : (
            /*
             * A turn that ended without getting anywhere: refused by a boundary, stopped, or failed.
             * Saying "opened during this turn" here would describe something that did not happen.
             */
            <span>This turn did not open a page.</span>
          )}
        </>
      ) : problem ? (
        <>
          <span className="font-medium">
            You cannot see the screen right now
          </span>
          <span>{problem}</span>
          <span>
            The assistant may still be working. An administrator can check
            whether its computer is running.
          </span>
        </>
      ) : blankBrowser ? (
        <span>The assistant has not opened a page yet.</span>
      ) : (
        <span>Waiting for the assistant's screen…</span>
      )}
    </span>
  );
}

/**
 * Height the viewer keeps for itself around the screen: the 56px top bar, the 32px row the status
 * pill sits in, and 24px below. Reserved whether or not the pill is showing, so the screen does not
 * jump when somebody takes control.
 */
const VIEWER_CHROME_PX = 56 + 32 + 24;
/** The 24px either side of the screen. */
const VIEWER_GUTTER_PX = 48;

type Props = {
  computerId: string;
  /** Whose screen this is. Absent, the Bot's own name is looked up. */
  name?: string | undefined;
  /** Width over height of the frames this computer sends. */
  frameAspect: number;
  onMinimize: () => void;
  /**
   * A finished turn: a record opened larger, not a window on the browser. No wheel, no recorder,
   * no live stream — those are about the present.
   */
  settled: boolean;
  /** The kept frame a finished turn shows. */
  drawn: { base64: string; format?: string | undefined } | null;
  /**
   * Whether the live stream is worth opening: something to draw, or somebody driving. Never for a
   * settled turn.
   */
  showLiveScreen: boolean;
  driving: boolean;
  control: ControlState | null;
  problem: string | null;
  blankBrowser: boolean;
  page?: { url?: string; title?: string } | undefined;
};

/**
 * The Bot's screen, near full-window.
 *
 * Grok's shape: whose screen it is top-left, the wheel, the recorder and a minimize button
 * top-right, and the screen itself as large as the window allows at the frame's own shape. The
 * shape matters to more than looks: `take-the-wheel.ts` maps a click on the canvas to the remote
 * page by the canvas's whole width and height, so the box is sized from the frame's aspect and both
 * window dimensions rather than stretched to fit.
 *
 * Minimize and Escape close it; the backdrop does not, so a click that misses the screen while
 * driving is not the end of the session. Escape is left alone while a dialog inside the viewer is
 * open ("Name this workflow"), where it belongs to that dialog.
 */
export function ScreenViewer({
  computerId,
  name,
  frameAspect,
  onMinimize,
  settled,
  drawn,
  showLiveScreen,
  driving,
  control,
  problem,
  blankBrowser,
  page,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const agent = useQuery(agentQueryOptions(computerId));
  const shownName = name ?? agent.data?.name;
  const [streamProblem, setStreamProblem] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const reconnect = useCallback(() => setRetryKey((value) => value + 1), []);
  /** Read at keydown time, so it is what was rendered, not what a listener earlier in the event set. */
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogOpenRef = useRef(false);
  dialogOpenRef.current = dialogOpen;

  // Into the viewer when it opens, and back to whatever opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement;
    rootRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // On the window so it works wherever focus is; the live screen lets Escape through for this.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dialogOpenRef.current) return;
      // A dialog of its own, opened from in here, closes first and alone.
      const dialog =
        event.target instanceof Element
          ? event.target.closest('[role="dialog"], [role="alertdialog"]')
          : null;
      if (dialog && dialog !== rootRef.current) return;
      onMinimize();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onMinimize]);

  const status = settled
    ? null
    : control?.transitioning
      ? "Finishing the current action…"
      : driving
        ? `You have control — click and type on the page.${control?.reason ? ` ${control.reason}` : ""}`
        : control?.requested
          ? `The assistant needs you. ${control.reason ?? ""}`.trim()
          : null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="The assistant's screen"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/85 text-white outline-none backdrop-blur-sm"
    >
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <brand.Avatar seed={agent.data?.avatarSeed ?? computerId} size={28} />
          {shownName ? (
            <span className="truncate text-[15px] font-semibold">
              {shownName}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            NOT ON A TURN THAT IS OVER. A record does not get a steering wheel: the wheel and the
            recorder are about whatever the Bot has open now, not the page this turn opened.
          */}
          {settled ? null : (
            <>
              <ComputerControlButton computerId={computerId} withTooltip />
              <RecordStepsButton
                botId={computerId}
                driving={driving}
                onDialogOpenChange={setDialogOpen}
                onRecordingChange={reconnect}
              />
            </>
          )}
          <Button
            aria-label="Minimize screen"
            className="text-white hover:bg-white/10 hover:text-white dark:hover:bg-white/10"
            onClick={onMinimize}
            size="icon"
            variant="ghost"
          >
            <IconArrowsMinimize className="size-4.5" />
          </Button>
        </div>
      </header>

      <div className="flex h-8 shrink-0 items-center justify-center px-4">
        {status ? (
          <p
            className="max-w-full truncate rounded-full bg-white/10 px-3 py-1 text-[13px]"
            role="status"
          >
            {status}
          </p>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-6">
        <div
          className={`relative overflow-hidden rounded-xl ${showLiveScreen ? "bg-black" : "bg-muted"}`}
          style={{
            width: `min(calc(100vw - ${VIEWER_GUTTER_PX}px), calc((100svh - ${VIEWER_CHROME_PX}px) * ${frameAspect}))`,
            aspectRatio: frameAspect,
          }}
        >
          {settled && drawn ? (
            /*
             * A record, opened larger. Not a window on the browser.
             *
             * Zooming a past turn used to mount the live stream and offer Take control, so the one
             * gesture for looking closer at what a turn did was also the one that replaced it with
             * whatever the Bot has open now. The kept frame exists to stop exactly that.
             */
            <img
              alt="What this turn had open"
              className="absolute inset-0 h-full w-full object-contain"
              src={frameSource(drawn)}
            />
          ) : showLiveScreen ? (
            <>
              <LiveScreen
                computerId={computerId}
                driving={driving}
                onProblem={setStreamProblem}
                retryKey={retryKey}
              />
              {/*
                A live screen that ends reports why through `onProblem`, and this is the branch that
                is mounted when it does. Without drawing it here the screen ended with the stale
                last frame frozen on the canvas and nothing said.
              */}
              {streamProblem ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/85 p-4 text-center text-sm text-muted-foreground">
                  <span>{streamProblem}</span>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setStreamProblem(null);
                      reconnect();
                    }}
                  >
                    Retry
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <NothingToSee
              blankBrowser={blankBrowser}
              page={page}
              problem={problem}
              settled={settled}
            />
          )}
        </div>
      </div>
    </div>
  );
}
