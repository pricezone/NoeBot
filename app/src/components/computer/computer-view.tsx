import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ClickyPanelRow } from "@/components/clicky/clicky-launcher";
import {
  ClickyScreenOverlay,
  containedFrame,
} from "@/components/clicky/clicky-overlay";
import { ClickyStateChip } from "@/components/clicky/clicky-state-chip";
import { useClickyCapability } from "@/lib/clicky/queries";
import {
  selectClickyPresence,
  useClickySession,
} from "@/lib/clicky/use-clicky-session";
import { useClickyViewerRequest } from "@/lib/clicky/viewer-request";
import {
  type Desktop,
  readComputerStatus,
  readPageFrame,
  readScreenshot,
  type Screenshot,
} from "@/lib/computers/screen";
import {
  sleepComputerIfQuiet,
  useComputerSleep,
} from "@/lib/computers/use-computer-sleep";
import { useComputerControl } from "@/lib/computers/use-control";
import { useTranslation } from "@/lib/i18n";
import { useUiStrings } from "@/lib/i18n/strings";
import { ChannelAvatar } from "../channels/avatar";
import { ComputerAsleep } from "./computer-asleep";
import { ComputerControlButton } from "./computer-controls";
import { useElementVisible, usePageVisible } from "./preview-visibility";
import { frameSource, NothingToSee, ScreenViewer } from "./screen-viewer";

/** Explicit blank-browser URLs use placeholder artwork; missing URL fields are treated as real pages. */
function isBlankBrowser(shot: Screenshot): boolean {
  if (shot.url === undefined) return false;
  const url = shot.url.trim();
  return url === "" || url === "about:blank";
}

/**
 * What each finished turn opened, and the frame it ended on, kept outside any component.
 *
 * MODULE SCOPE, BECAUSE THE TILE DOES NOT SURVIVE. A transcript re-renders freely and remounts the
 * tiles in it, and anything held in component state goes with it: the fresh mount has no page yet,
 * behaves for one render like a live turn, and reaches for the live screen. Keyed on the tool call,
 * which is the identity of the turn rather than of the component drawing it.
 *
 * Bounded, because a long conversation is a lot of screenshots. Oldest out first, and a turn whose
 * frame has been dropped falls back to naming its page.
 */
type RememberedTurn = {
  page?: { url?: string; title?: string };
  frame?: { base64: string; url: string };
  /** Whether the server has already been asked, so a turn with no frame is not asked again. */
  asked?: boolean;
};
const REMEMBERED_TURNS = new Map<string, RememberedTurn>();
const MAX_REMEMBERED_TURNS = 40;

function rememberTurn(toolCallId: string, patch: RememberedTurn): void {
  const existing = REMEMBERED_TURNS.get(toolCallId) ?? {};
  /*
   * A FRAME IS WRITTEN ONCE, which is what the server's own insert says and what this has to agree
   * with. Letting a later write win is exactly what went wrong: the tile restored the right frame and
   * then replaced it, one render later, with a screenshot of whatever the Bot had open by then.
   */
  const merged: RememberedTurn = { ...existing, ...patch };
  if (existing.frame) merged.frame = existing.frame;
  REMEMBERED_TURNS.delete(toolCallId);
  REMEMBERED_TURNS.set(toolCallId, merged);
  while (REMEMBERED_TURNS.size > MAX_REMEMBERED_TURNS) {
    const oldest = REMEMBERED_TURNS.keys().next().value;
    if (oldest === undefined) break;
    REMEMBERED_TURNS.delete(oldest);
  }
}

/** Default browser viewport ratio, reserved before the first screenshot arrives. */
const DEFAULT_ASPECT_RATIO = 1280 / 800;

/** Minimum readable inline screen size. */
const DEFAULT_MIN_WIDTH = 320;
const DEFAULT_MIN_HEIGHT = 200;

/** Preload without failing the poll loop when a frame cannot be decoded early. */
async function preloadFrame(frame: Screenshot): Promise<void> {
  try {
    const image = new Image();
    image.src = frameSource(frame);
    await image.decode();
  } catch {
    // Let the visible image element handle decode failures.
  }
}

/** Identical frames in a row that mean the page has stopped changing. */
const SETTLED_FRAMES = 3;

/** Hard cap for post-action polling on pages that never settle. */
const SETTLE_TIMEOUT_MS = 30_000;

/**
 * Take the person to the card in the conversation that answers what the Bot is asking for.
 *
 * THE CARD IS THE ONE PLACE TO ANSWER. The screen card used to draw its own password box and an
 * amber "The assistant needs you." bar, so a secret request appeared twice, in two designs, with two
 * submit paths; the Secure Form row in the chat (`SecretCard`, `HelpCard`) is now the only one, and
 * this finds it. A secret's row is opened straight away, since answering it is the point; a takeover
 * row is scrolled to and focused, its Open being a choice. Answers whether a card was found, so a
 * caller with somewhere else to send the person (the viewer, for a takeover) can.
 */
export function answerInChat(kind: "secret" | "help"): boolean {
  if (typeof document === "undefined") return false;
  const row = document.querySelector<HTMLElement>(
    `[data-request-card="${kind}"] [data-slot="secure-form-row"][data-state="open"]`,
  );
  if (!row) return false;
  row.scrollIntoView?.({ behavior: "smooth", block: "center" });
  const open = row.querySelector<HTMLButtonElement>("button");
  if (kind === "secret") open?.click();
  else open?.focus();
  return true;
}

type Props = {
  /** Which computer to watch. One shared computer unless each Bot has been given its own. */
  computerId: string;
  /** Off by default so idle Bot screens do not poll indefinitely. */
  active?: boolean;
  intervalMs?: number;
  /** Width divided by height. Overridable for a Bot whose computer is not the default shape. */
  aspectRatio?: number;
  minWidth?: number;
  minHeight?: number;
  /** Whose screen this is, drawn as a small badge over the frame. Absent, no badge is drawn. */
  name?: string;
  /**
   * Stops the screenshot polling while set, as if the card had scrolled out of view.
   *
   * The bot panel keeps this mounted behind its other tabs so a switch back is instant, and a
   * card nobody can see must not keep a request per second going. The control poll is shared and
   * stays, because the panel's own attention logic reads it whichever tab is showing.
   */
  paused?: boolean;
  /** A line under the card, such as whose screen it is. */
  caption?: ReactNode;
  /**
   * Whether the card carries its own wheel: the "who has control" line and Take control under the
   * picture. The bot panel's preview turns it off — there the card is the screen and its caption,
   * and the wheel is in the viewer the picture opens. When the Bot asks for help, the request strip
   * still shows, with a way into the viewer. Transcript tiles keep it.
   */
  controls?: boolean;
  /**
   * The page this turn left the browser on, for a turn that has finished.
   *
   * A conversation is a record, and a record must not change its mind. Without this, reopening a
   * conversation made every past turn fetch the screen as it is now, so an answer about Hacker News
   * from an hour ago sat under a picture of whatever the Bot has open today. The frame was live, the
   * caption was not, and the turn read as though it had browsed somewhere it never went.
   */
  page?: { url?: string; title?: string };
  /**
   * Whether the turn this tile belongs to has ended.
   *
   * SEPARATE FROM HAVING A PAGE. A navigation that was refused, failed or stopped ends without one,
   * and a tile that decided history by "do I have a page" left exactly those turns polling the live
   * screen for ever, under an answer that had nothing to do with what was on it.
   */
  finished?: boolean;
  /**
   * The tool call this tile belongs to, which is what a kept frame is filed under.
   *
   * Without it the tile can still name the page; with it, it can show the page. Optional because the
   * side panel is not a turn and has nothing to remember.
   */
  toolCallId?: string;
  /**
   * Open the full-window viewer on mount, as a click on the card would. The Skills tab's "Record
   * skill" arrives with it, so the person lands with Record your steps in front of them. Nothing
   * is pressed for them: taking over the Bot's browser stays their press.
   */
  openExpanded?: boolean;
  /** Called once when `openExpanded` has opened the viewer, so the caller can forget the request. */
  onExpandedOnce?: () => void;
  /**
   * Whether this card goes to sleep when nobody is using the computer (`use-computer-sleep.ts`).
   *
   * The bot panel's card does, and so does the viewer it opens: asleep, neither asks the computer
   * for anything, not a screenshot and not the live stream, and both show the Bot dozing with a way
   * to wake it. It also opens asleep when the computer says the browser has stopped and nothing has
   * happened here, rather than starting the browser for a picture of it. Off for a transcript tile,
   * where a running turn is somebody using the computer and a finished one polls nothing anyway.
   */
  sleeps?: boolean;
};

/** How often a desktop preview nobody is driving asks for a frame. */
const DESKTOP_PREVIEW_INTERVAL_MS = 3_000;

export function ComputerView({
  computerId,
  active = true,
  intervalMs = 1000,
  aspectRatio = DEFAULT_ASPECT_RATIO,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  name,
  paused = false,
  caption,
  controls = true,
  page,
  finished,
  toolCallId,
  openExpanded = false,
  onExpandedOnce,
  sleeps = false,
}: Props) {
  const { t } = useTranslation();
  const [shot, setShot] = useState<Screenshot | null>(null);
  /**
   * Whether this computer shows a desktop, and its shape. `undefined` until asked.
   *
   * Decides which frame is polled and the shape the card reserves for it. Asked before the first
   * frame rather than alongside it, so the card does not open as a page and then change shape into
   * a desktop a moment later.
   */
  const [desktop, setDesktop] = useState<Desktop | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(openExpanded);
  /*
   * The request to open is honoured once, on the render it arrives with, and reported back so the
   * address forgets it. A later true (the same address re-entered) opens the viewer again, which
   * is what re-entering it asks for.
   */
  useEffect(() => {
    if (!openExpanded) return;
    setExpanded(true);
    onExpandedOnce?.();
  }, [openExpanded, onExpandedOnce]);
  /**
   * A finished turn is history, and history is not polled.
   *
   * While a turn runs, the frames are that turn's own and freeze where it left them, which is right.
   * Reopening the conversation later is the case this guards: the component mounts with no frame,
   * and fetching one would put today's page under yesterday's answer. It shows the page that turn
   * actually left open instead, which is the thing being remembered.
   *
   * `page` is what marks a turn as settled history rather than one still going, so a caller that
   * knows nothing about the page keeps the old behaviour and nothing regresses.
   *
   * DELIBERATELY NOT "AND WE HAVE NO FRAME YET". That is what this said first, and it undid itself:
   * restoring the kept frame set the frame, which made the turn stop counting as history, which
   * restarted the polling this exists to prevent, which replaced the restored picture with the live
   * one. The turn being over is the fact; whether a picture has arrived yet is not.
   */
  if (toolCallId && page?.url) rememberTurn(toolCallId, { page });
  const knownPage =
    page?.url !== undefined
      ? page
      : toolCallId
        ? REMEMBERED_TURNS.get(toolCallId)?.page
        : undefined;
  const keptFrame = toolCallId
    ? (REMEMBERED_TURNS.get(toolCallId)?.frame ?? null)
    : null;
  /** Bumped when a frame arrives, because the store it lands in is not React state. */
  const [, setFrameArrived] = useState(0);

  const settled = !active && (finished || Boolean(knownPage));
  const ui = useUiStrings();
  const {
    control,
    busy: changingControl,
    change: changeControl,
  } = useComputerControl(computerId, !settled);
  const pageVisible = usePageVisible();
  const [previewRef, previewIntersecting] = useElementVisible<HTMLElement>();
  const driving = control?.holder === "human" && !control.transitioning;
  /** Read by the polling loop without restarting it on control changes. */
  const drivingRef = useRef(false);
  drivingRef.current = driving;

  /** Secret prompts keep the screen live even though the human does not hold the wheel. */
  const secretPending = Boolean(control?.secretWanted);
  const secretPendingRef = useRef(false);
  secretPendingRef.current = secretPending;

  const sleep = useComputerSleep(computerId, { enabled: sleeps && !settled });
  const wake = sleep.wake;
  /*
   * NEVER ASLEEP IN FRONT OF SOMEBODY WHO IS NEEDED, or already driving: a hand-off, a secret, a
   * change of control on its way. Each of those wakes it, so the timer starts again from there.
   */
  const needsPerson =
    driving ||
    secretPending ||
    Boolean(control?.requested) ||
    Boolean(control?.transitioning);
  useEffect(() => {
    if (sleep.asleep && needsPerson) wake();
  }, [sleep.asleep, needsPerson, wake]);
  const asleep = sleep.asleep && !needsPerson;
  // Arriving to record a skill is somebody about to use the computer.
  useEffect(() => {
    if (openExpanded && sleeps) wake();
  }, [openExpanded, sleeps, wake]);
  // Held in a ref so a slow response cannot overwrite a newer frame after the component moved on.
  const generation = useRef(0);

  const visualVisible =
    pageVisible && (expanded || (previewIntersecting && !paused));
  /*
   * How often the screen is polled. A desktop preview nobody is driving changes slowly and every poll
   * is a fresh capture on the machine, so it asks every few seconds rather than every second.
   */
  const pollEvery =
    desktop && !driving
      ? Math.max(intervalMs, DESKTOP_PREVIEW_INTERVAL_MS)
      : intervalMs;
  /** The full-window viewer is open on a live stream (see `showLiveScreen` below). */
  const liveInViewer =
    expanded &&
    !settled &&
    !asleep &&
    (driving || (shot !== null && !isBlankBrowser(shot)));

  /*
   * The frame this turn's page was showing, fetched once and then kept.
   *
   * A READ, AND ONLY A READ. The tile used to capture the frame itself once the turn went inactive,
   * and it kept filing the wrong picture: a reopened turn and one that has just finished look
   * identical from in here, the same computer is driven by other conversations between the two, and
   * a resumed computer starts blank. The frame is now taken on the server the moment the navigation
   * succeeds, which is the one moment the screen is certainly showing the page that was asked for,
   * so there is nothing left here to race.
   */
  useEffect(() => {
    if (!toolCallId || !settled) return;
    const remembered = REMEMBERED_TURNS.get(toolCallId);
    /*
     * Asked once per turn, answer or not. Without remembering the empty answer, every turn from
     * before this shipped refetched nothing on every remount, which on a long transcript is one
     * pointless request per turn per scroll.
     */
    if (remembered?.frame || remembered?.asked) return;
    let current = true;

    void (async () => {
      const stored = await readPageFrame(computerId, toolCallId);
      if (!current) return;
      rememberTurn(toolCallId, {
        asked: true,
        ...(stored ? { frame: { base64: stored.frame, url: stored.url } } : {}),
      });
      if (stored) setFrameArrived((n) => n + 1);
    })();

    return () => {
      current = false;
    };
  }, [computerId, toolCallId, settled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `secretPending` intentionally restarts settled polling.
  useEffect(() => {
    if (settled) return;
    if (!visualVisible) return;
    // The full-window viewer is showing the live stream: polling under it is the same screen twice.
    if (liveInViewer) return;
    // Asleep asks for nothing: on the shared computer a screenshot is what keeps a browser running.
    if (asleep) return;
    // Nor before the status is in, for a card that may open asleep: the first frame starts the browser.
    if (sleeps && desktop === undefined) return;
    const mine = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    // Consecutive identical frames observed during post-action settling.
    let unchanged = 0;
    let lastFrame = "";
    const graceStartedAt = Date.now();

    /** Continue while active, human-driven, secret-pending, or not yet visually settled. */
    const shouldContinue = () => {
      if (active) return true;
      if (drivingRef.current) return true;
      if (secretPendingRef.current) return true;
      if (Date.now() - graceStartedAt > SETTLE_TIMEOUT_MS) return false;
      return unchanged < SETTLED_FRAMES;
    };

    // Always fetch at least one frame; only repeated refreshes are conditional.
    const tick = async () => {
      try {
        const { frame, error } = await readScreenshot(computerId, {
          desktop: Boolean(desktop),
        });
        if (generation.current !== mine) return;

        if (!frame) {
          setProblem(error ?? t("The screen is not available right now."));
        } else {
          // Exact byte comparison is the settling signal.
          unchanged = frame.base64 === lastFrame ? unchanged + 1 : 0;
          lastFrame = frame.base64;
          // Decode before swapping to avoid blanking the visible image during data URL changes.
          await preloadFrame(frame);
          if (generation.current !== mine) return;
          setShot(frame);
          setProblem(null);
        }
      } finally {
        if (generation.current === mine && shouldContinue()) {
          timer = setTimeout(tick, pollEvery);
        }
      }
    };

    void tick();
    return () => {
      generation.current++;
      clearTimeout(timer);
    };
  }, [
    computerId,
    active,
    pollEvery,
    secretPending,
    settled,
    visualVisible,
    desktop,
    liveInViewer,
    asleep,
    sleeps,
  ]);

  /*
   * Which screen this computer has, and whether its browser is running. A finished turn shows its
   * kept frame and never asks. A browser that has stopped (the computer's idle sweep closed it) opens
   * asleep unless something has just happened here, rather than being started for a picture.
   */
  useEffect(() => {
    if (settled) return;
    let current = true;
    setDesktop(undefined);
    void readComputerStatus(computerId).then(({ desktop: found, browser }) => {
      if (!current) return;
      if (sleeps && browser === "stopped") sleepComputerIfQuiet(computerId);
      setDesktop(found);
    });
    return () => {
      current = false;
    };
  }, [computerId, settled, sleeps]);

  // Always render the card frame; help/secret controls live below the conditional picture.
  /*
   * A finished turn is never "blank": it opened a page, and that is what it shows or names. Only a
   * live browser can be sitting on about:blank.
   */
  const blankBrowser = !settled && shot ? isBlankBrowser(shot) : false;

  /*
   * Sized from the ratio, never from the payload, so the frame is identical while a screen is
   * loading, once it arrives, and while the browser has nothing open. A blank browser used to
   * collapse to a strip of text; that made the panel change shape the moment a page opened, and a
   * surface whose whole job is showing a screen kept surprising the layout around it.
   */
  const frameAspect = desktop ? desktop.width / desktop.height : aspectRatio;
  const frameStyle = { aspectRatio: frameAspect, minWidth, minHeight };
  /**
   * What this tile draws: the kept frame for a turn that is over, the live one while it runs.
   *
   * A finished turn never draws `shot`. It may hold one, caught in the render between mounting and
   * its result arriving, and that frame is of whatever the Bot has open now rather than of this turn.
   */
  const drawn = settled
    ? keptFrame
    : shot
      ? { base64: shot.base64, url: shot.url ?? "", format: shot.format }
      : null;
  /** Whether there is a page to draw. A blank browser and an unreadable screen are both "no". */
  const showScreen = drawn !== null && !blankBrowser;
  /**
   * Whether the full-window view has a stream worth opening.
   *
   * Nothing to draw, and it says so in the same words the card does — but somebody holding the wheel
   * gets the live socket whatever is on it, because once a person is driving the stream is the truth
   * about the page and a placeholder over it would be the view arguing with them.
   */
  const showLiveScreen = !settled && !asleep && (showScreen || driving);
  /**
   * Whether the wheel in somebody's hands is the wheel THIS tile is showing.
   *
   * A person can take control mid-navigation, and the turn then settles under them. `driving` stays
   * true, because it is true: they are driving the browser. It is just not the browser in this
   * picture any more. Left ungated, the frozen tile asserted "You have control" over a page from an
   * hour ago, with the hand-back footer already gone.
   */
  const wheelHere = driving && !settled;

  /**
   * "Keep control" in the viewer: whether minimizing it leaves the wheel with the person.
   *
   * Off by default and only for the hold it was switched on in. It goes back to off when control
   * returns to the Bot and when a new take starts, so somebody who did not ask to keep control
   * this time is not left holding the Bot's browser because they once did.
   */
  const [keepControl, setKeepControl] = useState(false);
  const holder = control?.holder;
  useEffect(() => {
    if (holder === "bot") setKeepControl(false);
  }, [holder]);
  const onTakeControl = useCallback(() => setKeepControl(false), []);

  /*
   * MINIMIZING HANDS CONTROL BACK; there is no separate "Hand back" any more. It goes through the
   * shared store's own release, the path that button took, and closes only once that has worked: a
   * release that fails keeps the viewer open with the control button saying why, rather than
   * closing on a person who still holds a wheel they can no longer see. The store also refuses a
   * change while the Bot's current action is finishing, and the viewer's status pill says so. With
   * "Keep control" on, while the Bot holds control, or while a request is only waiting, minimizing
   * just closes.
   */
  const minimize = useCallback(() => {
    if (holder !== "human" || keepControl) {
      setExpanded(false);
      return;
    }
    void changeControl?.("release").then((released) => {
      if (released) setExpanded(false);
    });
  }, [holder, keepControl, changeControl]);

  /*
   * Clicky on the preview: its pointer and boxes over the picture and a chip saying where it is, for
   * a screen that is live and awake. The panel's card (the one that sleeps) also carries Clicky's
   * switch, and opens the viewer when Clicky asks for it (the Bot needing the person).
   */
  const clicky = useClickyCapability();
  const clickyOn = clicky.enabled && !settled && !asleep;
  const clickyPresence = useClickySession(
    computerId,
    clickyOn,
    "preview",
    selectClickyPresence,
  );
  const clickyAwake = clickyOn && clickyPresence?.awake === true;
  /*
   * The picture is fitted whole inside the card (`object-contain`), so a frame of another shape
   * than the card is drawn with bands beside it; Clicky's layer covers the picture, not the bands.
   */
  const clickyFrame = containedFrame(
    frameAspect,
    shot && shot.width > 0 && shot.height > 0
      ? shot.width / shot.height
      : frameAspect,
  );
  const openViewer = useCallback(() => setExpanded(true), []);
  useClickyViewerRequest(
    computerId,
    sleeps && clicky.enabled && !settled,
    openViewer,
  );

  const polledScreen = showScreen ? (
    <img
      src={frameSource(drawn)}
      alt={t("What the assistant is looking at")}
      // Keep unexpected screenshot dimensions inside the reserved frame.
      className="absolute inset-0 h-full w-full object-contain opacity-100 transition-opacity duration-300 starting:opacity-0"
    />
  ) : null;

  return (
    <>
      {/*
       * The figure is the intersection target and holds the caption; the card inside it clips the
       * frame to its corners, so a caption is outside the border rather than drawn into the card.
       */}
      <figure ref={previewRef} className="flex flex-col gap-2">
        <div className="overflow-hidden rounded-2xl border">
          {/* Inline preview remains in transcript; click opens the full-window viewer. */}
          {asleep ? (
            /* Asleep: the Bot dozing where its screen would be. A click anywhere on it wakes it. */
            <div className="relative block w-full bg-muted" style={frameStyle}>
              <ComputerAsleep botId={computerId} onWake={wake} />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              /*
               * Opens whether or not there is a picture in it. It used to be disabled without one, and
               * the wheel is in there: a blank browser, a screen that had not arrived yet, or a
               * computer that could not be reached left a person with no way to take control at all —
               * the states where they most want it. With nothing to draw the viewer shows these same
               * words, and the wheel above them.
               */
              className="relative block w-full cursor-pointer bg-muted"
              style={frameStyle}
              aria-label={t("Open the assistant's screen full size")}
            >
              {polledScreen}

              {clickyAwake && showScreen ? (
                <span
                  className="pointer-events-none absolute"
                  data-slot="clicky-frame"
                  style={clickyFrame}
                >
                  <ClickyScreenOverlay botId={computerId} compact />
                </span>
              ) : null}
              {clickyAwake ? (
                <ClickyStateChip
                  className="absolute top-2 left-2 z-20 bg-black/60 text-white backdrop-blur-sm"
                  session={clickyPresence}
                />
              ) : null}

              {/* Whose computer this is — and whose hands are on it — said on the picture itself. */}
              {name || wheelHere ? (
                <span className="absolute right-2 bottom-2 flex items-center gap-1.5">
                  {name ? (
                    <span className="flex items-center gap-1.5 rounded-full bg-black/60 py-1 pr-2.5 pl-1.5 font-medium text-white text-xs backdrop-blur-sm">
                      <ChannelAvatar participantIds={[computerId]} size={16} />
                      {name}
                    </span>
                  ) : null}
                  {wheelHere ? (
                    <span className="rounded-full bg-white px-2.5 py-1 font-medium text-black text-xs shadow-sm">
                      {t("You have control")}
                    </span>
                  ) : null}
                </span>
              ) : null}

              {showScreen ? null : (
                <NothingToSee
                  blankBrowser={blankBrowser}
                  page={knownPage}
                  problem={problem}
                  settled={settled}
                />
              )}
            </button>
          )}

          {/*
           * WHAT THE BOT IS ASKING FOR, AND WHERE TO ANSWER IT: one muted line, and a link to the
           * card in the conversation that answers it. A takeover with no card in sight (the panel
           * opened on its own, say) opens the viewer instead, where the wheel is.
           */}
          {!settled &&
          !driving &&
          (control?.secretWanted || control?.requested) ? (
            <div
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-3 py-2 text-sm"
              data-slot="request-pointer"
            >
              <span className="min-w-0 text-muted-foreground">
                {control.secretWanted
                  ? ui.botNeedsValue(control.secretWanted)
                  : control.reason
                    ? `${ui.botNeedsYou} ${control.reason}`
                    : ui.botNeedsYou}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <button
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    const kind = control.secretWanted ? "secret" : "help";
                    if (!answerInChat(kind) && kind === "help")
                      setExpanded(true);
                  }}
                  type="button"
                >
                  {ui.answerInChat}
                </button>
                {control.requested ? (
                  <button
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    disabled={changingControl}
                    onClick={() => void changeControl?.("cancel")}
                    type="button"
                  >
                    {ui.cancelRequest}
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}
          {sleeps && clickyOn ? (
            <ClickyPanelRow
              botId={computerId}
              onOpenScreen={openViewer}
              session={clickyPresence}
            />
          ) : null}
          {!settled && control?.transitioning ? (
            <p className="px-3 py-2 text-sm">{ui.finishingBeforeHandover}</p>
          ) : null}
          {!settled && control?.request?.status === "interrupted" ? (
            <p className="px-3 py-2 text-sm">
              {ui.browserInterrupted(control.request.interruption)}
            </p>
          ) : null}

          {!settled && controls ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {!control
                  ? ui.checkingControl
                  : control.transitioning
                    ? ui.finishingAction
                    : driving
                      ? ui.youHaveControl
                      : ui.botHasControl}
              </span>
              {/*
                While the person holds control this reads "Open screen": the card has no minimize,
                so the viewer is where they drive and where minimizing hands control back.
              */}
              <ComputerControlButton
                computerId={computerId}
                onOpenScreen={() => setExpanded(true)}
                onTakeControl={() => {
                  onTakeControl();
                  setExpanded(true);
                }}
              />
            </div>
          ) : null}
        </div>
        {caption !== undefined && caption !== null ? (
          <figcaption className="text-center text-[13px] text-muted-foreground">
            {caption}
          </figcaption>
        ) : null}
      </figure>

      {/*
        Portal to body so fixed positioning is measured against the viewport, not containing panes.
      */}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            <ScreenViewer
              asleep={asleep}
              blankBrowser={blankBrowser}
              computerId={computerId}
              control={control}
              drawn={settled ? drawn : null}
              driving={driving}
              frameAspect={frameAspect}
              keepControl={keepControl}
              name={name}
              onKeepControlChange={setKeepControl}
              onMinimize={minimize}
              onTakeControl={onTakeControl}
              {...(sleeps ? { onActivity: wake, onWake: wake } : {})}
              page={knownPage}
              problem={problem}
              settled={settled}
              showLiveScreen={showLiveScreen}
            />,
            document.body,
          )
        : null}
    </>
  );
}
