import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ServerWebSocket, serve } from "bun";
import type { Page, Response as PageResponse } from "playwright";
import type { BrowserChallenge } from "../../shared/computer-control";
import { downloadHeaders } from "../../shared/file-download";
import {
  type ActingOptions,
  chooseOption,
  clickElement,
  type FillOutcome,
  fillForm,
  guarded,
  hoverElement,
  parseFill,
  scrollElement,
  setChecked,
  typeInto,
  uploadFile,
} from "./acting";
import {
  elementProblem,
  isElementProblem,
  isRequestError,
  requestError,
  summariseError,
} from "./action-errors";
import {
  normaliseText,
  parseAriaSnapshot,
  type SnapshotElement,
} from "./aria-snapshot";
import {
  actsOnTheComputer,
  isOpenPath,
  matchesToken,
  mutatesBrowser,
  needsFreshLook,
  offeredToken,
} from "./authorisation";
import { isPlainBotId } from "./bot-id";
import {
  openStartPage,
  raiseBrowserWindow,
  watchBrowserRequests,
} from "./browser-request";
import { browserRuntimeFromEnv } from "./browser-runtime";
import { warmUpBrowser } from "./browser-warmup";
import { detectChallenge } from "./challenge";
import {
  ControlError,
  ControlRequestError,
  NO_SECRET_PENDING,
  SnapshotRequiredError,
  TAKE_CONTROL_FIRST,
} from "./control";
import { describeHumanGesture } from "./demonstration";
import { fitWidth, frameWidthFrom } from "./element-geometry";
import {
  elementAtScreen,
  emptyScreen,
  focusOn,
  listScreenElements,
  maskedFrame,
  type ScreenElements,
} from "./elements";
import { startDesktop } from "./desktop";
import {
  captureDesktopFrame,
  startDesktopCast,
  streamSettingsFromEnv,
} from "./desktop-cast";
import { createDialogKeeper, type DialogInfo } from "./dialogs";
import {
  createDownloadKeeper,
  partialDownloadsDir,
  type SavedDownload,
} from "./downloads";
import { handleEgressPolicyRequest, startEgressFilter } from "./egress";
import { settleWithin } from "./env";
import { previousEntry } from "./history";
import { identity } from "./identity";
import { inOrder } from "./in-order";
import {
  assertPageAccess,
  isSiteFailure,
  navigateWebPage,
  type PagePurpose,
  siteFailureOf,
} from "./navigation";
import { observeAction } from "./observe";
import { pageLines } from "./page-lines";
import { clickableHints, readablePageText, settlePage } from "./page-text";
import { readWait, waitForPageText } from "./page-wait";
import {
  createProfiles,
  managedBrowserExecutable,
  numberFromEnv,
  startPageFor,
} from "./profiles";
import {
  parseExecTimeout,
  parseInputMessage,
  parseNavigateUrl,
  parseScrollDelta,
} from "./request-validation";
import { type InputMessage, startScreencast } from "./screencast";
import {
  maskSensitiveValues,
  SENSITIVE_FIELD_SELECTOR,
  sensitiveRefs,
} from "./secret-masking";
import { browserPid, focusedWindow, windowUnderPointer } from "./screen-window";
import { type BotSession, createSessions } from "./sessions";
import { createShell } from "./shell";
import {
  fillSignIn,
  parseSignInFill,
  probeSignIn,
  typeSecretValue,
} from "./sign-in";
import { displaySizeFromEnv, startVirtualDisplay } from "./virtual-display";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspaceFileNotFoundError,
  WorkspaceFileTooLargeError,
  WorkspacePathError,
} from "./workspace";
import { openXInput, type XInput } from "./x-input";
import { wheelClicks, xKeysForCombo } from "./x-keys";

/**
 * The Bot's computer: one long-lived browser, reachable over HTTP.
 *
 * Acting on a page lives in this process because only this process holds the browser. In the
 * intended deployment path, the server gateway decides whether an action may run and records the
 * audit row before calling this process. This process has no policy engine and no audit trail of its
 * own; its direct-port boundary is the computer token.
 *
 * `/files/read`, `/files/download` and `/files/write` reach the durable workspace volume, confined
 * to it by workspace.ts. Reading and writing are the two operations a Bot needs to keep notes between
 * turns; download returns the exact bytes so a PDF, image or archive is not damaged by text decoding.
 *
 * Elements are addressed by reference, not by pixel. `/snapshot` stamps every interactive element
 * with a ref and hands back a compact list; `/click` and `/type` take one of those refs. That is the
 * accessibility-tree-first driver this is built on, and it is why filling in a form needs no
 * vision model at all: the Bot reads a list of fields rather than squinting at a picture and guessing
 * coordinates. Pixels remain the eventual fallback for canvas-style pages that expose no elements.
 *
 * One browser stays open so state survives between
 * turns: a session it signed into an hour ago is still signed in now. Launching per request would
 * make every task start from a cold, logged-out browser, which is the behaviour we are specifically
 * trying not to have.
 *
 * It authenticates its caller: every request must present the secret below, and the process refuses
 * to start without one. That is a lock on the door rather than a reason to put the door somewhere
 * public. It still belongs on the deployment network, behind the server that decides who is asking.
 */

/**
 * The secret every caller must present.
 *
 * This process drives a browser that holds real logins. Policy, audit, actor identity and SPIFFE
 * identity live in the server and are not on the direct computer port.
 *
 * Refusing to start without a token makes missing authentication a deployment failure, never an open
 * computer.
 */
const COMPUTER_TOKEN = process.env.COMPUTER_TOKEN?.trim();
if (!COMPUTER_TOKEN) {
  console.error(
    "COMPUTER_TOKEN is not set. This process drives a browser holding real logins and will not start without the secret its caller must present.",
  );
  process.exit(1);
}

const RUNTIME = browserRuntimeFromEnv(process.env);
const BROWSER_MODE = RUNTIME.mode;
const DISPLAY_SIZE = displaySizeFromEnv(
  process.env.COMPUTER_DISPLAY_SIZE,
  RUNTIME.desktop,
);
const VIRTUAL_DISPLAY = await startVirtualDisplay(
  RUNTIME.useVirtualDisplay ? "headed" : "headless",
  undefined,
  DISPLAY_SIZE,
);
if (VIRTUAL_DISPLAY) process.env.DISPLAY = VIRTUAL_DISPLAY.name;
/** How the desktop's live screen is encoded. See `streamSettingsFromEnv`. */
const DESKTOP_STREAM = streamSettingsFromEnv(process.env, DISPLAY_SIZE);

/** The desktop around the browser, when `COMPUTER_DESKTOP=on`. See desktop.ts. */
const DESKTOP =
  RUNTIME.desktop && VIRTUAL_DISPLAY
    ? await startDesktop({ display: VIRTUAL_DISPLAY.name })
    : null;
console.info(
  JSON.stringify({
    type: "computer-browser-mode",
    mode: BROWSER_MODE,
    display: VIRTUAL_DISPLAY?.name ?? null,
    desktop: DESKTOP ? { ...DISPLAY_SIZE, ready: DESKTOP.ready } : null,
  }),
);

/*
 * A whole port in range, or the default: a fraction never binds and an out-of-range one
 * misbinds at boot, which is a deployment failure instead of the documented fallback.
 */
const PORT = numberFromEnv("PORT", 4100, { min: 1, max: 65535 });
const NAVIGATION_TIMEOUT_MS = numberFromEnv("NAVIGATION_TIMEOUT_MS", 30000);

/**
 * How long one action waits for its element.
 *
 * Much shorter than a navigation. Playwright waits for a control to become clickable, which is the
 * behaviour we want, but a ref that no longer resolves would otherwise hang for the full navigation
 * timeout before saying so, and the person is sitting watching a screen that is not changing.
 */
const ACTION_TIMEOUT_MS = numberFromEnv("ACTION_TIMEOUT_MS", 10000);

/**
 * How much page text a navigation hands back.
 *
 * Bounded because a page can be megabytes and the text goes into a model's context, where a single
 * unbounded page can push the rest of the conversation out. Generous enough that the visible part of
 * an ordinary page arrives whole, which is what the answer is usually made of.
 */
const TEXT_EXTRACT_LIMIT = 6000;

/**
 * How much page text a navigation hands back, now that it also hands back the page's elements.
 *
 * The first screen of an ordinary page fits, which is usually the answer; `computer_read` has the
 * full extract for the rest.
 */
const NAVIGATE_TEXT_LIMIT = 2000;

/**
 * Which snapshot the caller's refs came from.
 *
 * Kept as a caller-facing guard even though Playwright enforces the real thing underneath. The
 * published tool contract says an action carries the `snapshotId` it got, and a mismatch is answered
 * with "take a new snapshot", which is a clearer message for a model than an element that merely fails
 * to resolve. Playwright's `aria-ref` engine is the runtime enforcement: it resolves a ref only against
 * the most recent snapshot, only while the element is still connected to the document, and it mints a
 * new ref if an element's role or accessible name changed, so a recycled node cannot inherit an old one.
 *
 * The counter, the run it belongs to, and the sessions holding both live in their own module: the
 * rules about when a run changes are testable there, and not here, because this file launches a
 * browser the moment it is imported.
 */
const sessions = createSessions({
  isLive: (botId) => profiles.isLive(botId),
  profilesDirectory: process.env.PROFILES_DIR?.trim() || "/profiles",
  desktop: RUNTIME.desktop,
});

/**
 * Sent by the server as a header on every call. Absent means the caller does not know or does not
 * care, such as a health check, and that gets the default computer rather than an error, because
 * refusing it would make the container undemonstrable on its own.
 */
function botIdOf(request: Request, fallback?: string | null): string {
  return (
    request.headers.get("x-openbot-bot-id")?.trim() ||
    fallback?.trim() ||
    DEFAULT_BOT_ID
  );
}

/**
 * The Bot's durable files.
 *
 * Rooted at WORKSPACE_DIR, which the image creates and docker-compose mounts as a volume, so what a
 * Bot saves outlives the container. Built once at boot: the root is fixed, and resolving it per request
 * would only add a syscall to every call. Everything about why confinement is harder than it looks
 * lives in workspace.ts.
 */
/**
 * The two directories this process cannot do its job without, checked before it says it is ready.
 *
 * WHY A CHECK AND NOT A CRASH LATER. Neither of these fails loudly on its own. A persistent
 * Chromium profile it cannot write is not an error to Chromium: `launchPersistentContext` falls
 * back to a throwaway profile, so the Bot is signed out of everything and the container is healthy.
 * `profiles.ts` swallows the EACCES on cleanup for its own good reasons. So the failure that
 * actually happens in the field is a green pod and an empty profile, which is the worst shape a
 * failure can take: nothing to read, and a week of logins gone.
 *
 * WHEN IT HAPPENS. The volume is created root-owned and something has to hand it over. In Docker
 * the image does it at build time; on Kubernetes the kubelet does it from `fsGroup`, which it
 * applies only where the volume plugin reports it can. `hostPath` reports it cannot, and that is
 * what rancher/local-path-provisioner hands out by default, which is the default StorageClass on
 * k3s. There, uid 1001 gets a directory it cannot even list.
 *
 * Exiting non-zero turns that into a CrashLoopBackOff with a readable reason, which an operator can
 * act on: chown the directory, or set `computers.podSecurityContext: null`.
 */
async function assertWritable(label: string, directory: string) {
  const probe = join(directory, `.openbot-write-probe-${process.pid}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "");
    await rm(probe, { force: true });
  } catch (error) {
    console.error(
      `${label} at ${directory} is not writable by uid ${process.getuid?.() ?? "unknown"}: ${String(error)}. ` +
        "A Bot's files and browser profile live here, and a profile this process cannot write is one Chromium silently replaces with a throwaway, so this refuses to start instead. " +
        "On Kubernetes this usually means the volume's storage class does not apply fsGroup, which hostPath-backed provisioners such as local-path do not: chown it to the pod's uid, or set computers.podSecurityContext to null.",
    );
    process.exit(1);
  }
}

await assertWritable(
  "The workspace",
  process.env.WORKSPACE_DIR?.trim() || "/workspace",
);
await assertWritable(
  "The browser profiles directory",
  process.env.PROFILES_DIR?.trim() || "/profiles",
);

const workspace = createWorkspace(
  process.env.WORKSPACE_DIR?.trim() || "/workspace",
);

/**
 * JavaScript dialogs, held for the Bot to answer, and downloads, saved into its workspace. Both
 * listen on every browser as it launches (the hook on `createProfiles` below).
 *
 * A dialog is dismissed at once while a person holds the wheel, as every dialog was before: the
 * live screen cannot draw one, so holding it would freeze the page under them.
 */
const dialogs = createDialogKeeper({
  dismissAtOnce: (botId) =>
    sessions.get(botId)?.control.get().holder === "human",
});
const MEGABYTE = 1024 * 1024;
const downloads = createDownloadKeeper(workspace, {
  limits: {
    // One file, and the whole Downloads folder: any site can start a download, and the disk is shared.
    fileBytes: numberFromEnv("COMPUTER_DOWNLOAD_MAX_MB", 100) * MEGABYTE,
    folderBytes: numberFromEnv("COMPUTER_DOWNLOADS_MAX_MB", 1024) * MEGABYTE,
  },
  partialDir: partialDownloadsDir,
});

/**
 * Who has the wheel, as a state machine in its own module.
 *
 * The state machine lives in `control.ts` so it can be tested without importing Playwright.
 */

/**
 * The Bot's browser and the profile that outlives it. See profiles.ts.
 *
 * `chromium.launch()` gives a fresh anonymous profile every time. Persistent profiles live on a
 * mounted volume so sign-in state survives the container.
 */
/**
 * The browsers, and what a closing one takes with it.
 *
 * Every close announces itself here, whether it came from a request, the cap, or the idle sweep, and
 * the live screen watching that Bot comes down with it. Hanging this off the close rather than
 * calling it from the stop and reset handlers is what covers the two closes no request makes: a
 * viewer that outlived one of those kept a 1Hz loop asking for a page, which starts a browser, so
 * the Bot was immune to the idle timeout and came straight back after a cap eviction.
 *
 * `sessions.get`, never `sessions.for`: a Bot with no session has nobody watching, and inventing one
 * here would put an entry in the map on the path that closes browsers, which is where the map is
 * meant to shrink.
 */
// Every browser and shell launched below goes through the policy filter, which still chains to the
// per-Bot upstream proxy. Started before any browser exists so nothing escapes it.
// Only the running computer points its shell at it: a test that imports this module shares its
// process with every later test.
await startEgressFilter({ forShell: import.meta.main });
const profiles = createProfiles(
  process.env.PROFILES_DIR?.trim() || "/profiles",
  async (botId) => {
    if (sessions.get(botId)) sessions.renewRun(botId);
    dialogs.forget(botId);
    downloads.forget(botId);
    await sessions.get(botId)?.viewer.releaseAll(COMPUTER_STOPPED);
  },
  // Before any page is used, so no dialog is auto-dismissed and no download lost. See dialogs.ts.
  (botId, context) => {
    dialogs.attach(botId, context);
    downloads.attach(botId, context);
  },
);
/*
 * A hidden headless launch at boot, so the first real one finds the browser in memory: 11.5 s
 * became 0.7 s on a Fly instance. See browser-warmup.ts.
 */
const BROWSER_EXECUTABLE = managedBrowserExecutable();
if (BROWSER_EXECUTABLE && import.meta.main) {
  void warmUpBrowser(BROWSER_EXECUTABLE).then(
    (result) =>
      console.info(
        JSON.stringify({ type: "computer-browser-warmed", ...result }),
      ),
    (error: unknown) =>
      console.warn(
        JSON.stringify({
          type: "computer-browser-not-warmed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
  );
}
// Rooted in the same workspace the file tools use, so a command and a written file see one
// directory rather than two.
const shell = createShell(
  process.env.WORKSPACE_DIR?.trim() || "/workspace",
  process.env,
);

/**
 * The id normally arrives as a header on every request. This is the fallback for a caller that has no
 * Bot to name, such as a health check, so the container stays demonstrable on its own rather than
 * refusing everything that is not the server.
 */
const DEFAULT_BOT_ID = (() => {
  const configured = process.env.COMPUTER_BOT_ID ?? "shared";
  // At boot rather than per request. This is the id every unheadered call falls back to, so a value
  // the path rules refuse would answer 400 to everything and read as a broken computer.
  if (!isPlainBotId(configured)) {
    throw new Error(
      "COMPUTER_BOT_ID may contain only letters, digits, hyphen and underscore, and must start with a letter or digit.",
    );
  }
  return configured;
})();

/** The Bot whose browser was last in use: the one the dock's Chrome button brings back. */
let lastBrowserBot: string | null = null;

async function currentPage(
  botId: string,
  purpose: PagePurpose = "read",
): Promise<Page> {
  const session = sessions.for(botId);
  const page = await profiles.page(botId);
  lastBrowserBot = botId;
  sessions.observeBrowser(botId, page.context());
  assertPageAccess(RUNTIME.backend, page.url(), purpose);
  // A ref names an element on the page it was taken from, so moving to a window the site opened has
  // to retire the outstanding ones exactly as a navigation does, or a click lands on the wrong document.
  if (session.livePage && session.livePage !== page) session.snapshotId += 1;
  session.livePage = page;
  return page;
}

/**
 * The Bot's page when its browser is already open, and null when it is not. Clicky only looks: a
 * question about the screen must not start a browser the person never asked for.
 */
async function livePageOf(botId: string): Promise<Page | null> {
  if (!profiles.isLive(botId)) return null;
  return currentPage(botId);
}

/** Said when a page-only computer is asked about a screen it is not showing. */
const BROWSER_NOT_OPEN =
  "The browser is not open, so there is no page to look at.";

/**
 * The last `/elements` answer per Bot, so `/elements/at` can name the ref of the box under a point
 * without measuring the whole page again. Only a name: what is there is asked of the page each time.
 */
const knownElements = new Map<string, ScreenElements>();

/**
 * The desktop's pointer and keyboard for input Clicky carries out in screen space, opened on first
 * use like the live screen's (desktop-cast.ts), and kept.
 */
let screenInput: Promise<XInput> | undefined;
function screenInputFor(display: string): Promise<XInput> {
  screenInput ??= openXInput(display);
  return screenInput;
}

/**
 * The dock's Chrome button: a browser, opened again if it was closed and brought to the front either
 * way. Whose: the Bot whose screen a person is driving; else the Bot that last used a browser; else,
 * after a restart, the profile used last. See browser-request.ts.
 */
const BROWSER_REQUESTS = DESKTOP
  ? await watchBrowserRequests(DESKTOP.browserRequestDir, async () => {
      const botId =
        sessions.drivenByPerson() ??
        lastBrowserBot ??
        (await profiles.lastUsed()) ??
        DEFAULT_BOT_ID;
      console.info(
        JSON.stringify({ type: "computer-desktop-browser-request", botId }),
      );
      const page = await currentPage(botId);
      // A browser launched for this click is on the start page already (profiles.ts); this is for one
      // still blank because its start page did not load. The window comes forward while Google loads.
      await openStartPage(page, startPageFor(botId));
      await raiseBrowserWindow(page);
    })
  : null;

/**
 * Describe everything on the page a Bot can act on.
 *
 * Uses Playwright's AI snapshot rather than stamping attributes into the DOM. `ariaSnapshot` keeps
 * refs outside the page, survives framework re-renders, resolves accessible names, reports current
 * values and checked state, filters to actionable elements and descends into iframes.
 */
async function snapshotPage(
  session: BotSession,
  target: Page,
): Promise<{
  snapshotId: number;
  url: string;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
}> {
  const snapshotId = ++session.snapshotId;
  const before = session.control.get();
  // In parallel: three questions to the same page, none of which waits on another.
  const [yaml, title, clickableTexts] = await Promise.all([
    target.ariaSnapshot({ mode: "ai" }),
    target.title(),
    clickableHints(target),
  ]);
  if (
    session.snapshotId === snapshotId &&
    before.holder === "bot" &&
    !before.requested
  )
    session.control.snapshotTaken();
  const parsed = parseAriaSnapshot(yaml, { clickableTexts });
  // A password field's value is in the aria snapshot in plain text. See secret-masking.ts.
  const elements = maskSensitiveValues(
    parsed.elements,
    await sensitiveRefs(target, parsed.elements),
  );
  const url = target.url();
  session.lastSnapshot = { snapshotId, url, elements };
  return { snapshotId, url, title, truncated: parsed.truncated, elements };
}

/** The ref the latest snapshot gave a button or link with this label, for naming a banner's. */
function refFor(session: BotSession): (label: string) => string | undefined {
  const PRESSABLE = new Set([
    "button",
    "link",
    "clickable",
    "menuitem",
    "tab",
    "checkbox",
    "switch",
  ]);
  return (label) => {
    const wanted = normaliseText(label);
    return session.lastSnapshot?.elements.find(
      (element) =>
        PRESSABLE.has(element.role) && normaliseText(element.name) === wanted,
    )?.ref;
  };
}

/**
 * The page an action left behind, as every acting result carries it.
 *
 * `elements` are compact lines (page-lines.ts), only what changed when the URL did not; `snapshot`
 * is the full list for the server to store, so the refs in those lines resolve for the next action.
 * The server takes `snapshot` off before the model sees the result.
 */
type ReportedPage = {
  url: string;
  title: string;
  status?: number;
  snapshotId: number;
  elements: string[];
  changed?: true;
  dialog?: DialogInfo;
  opened?: { url: string };
  download?: SavedDownload;
  loading?: true;
  notes?: string[];
  snapshot?: { elements: SnapshotElement[]; truncated: boolean };
};

/** A page that is waiting on a dialog can answer nothing that runs script, so it is not snapshotted. */
function frozenPage(
  session: BotSession,
  target: Page,
  dialog: DialogInfo,
  extras: { status?: number; opened?: { url: string } } = {},
): ReportedPage {
  return {
    url: target.url(),
    title: "",
    ...(extras.status !== undefined ? { status: extras.status } : {}),
    snapshotId: session.snapshotId,
    elements: [],
    dialog,
    ...(extras.opened ? { opened: extras.opened } : {}),
    notes: [
      `The page is showing a ${dialog.type} dialog and is paused until it is answered: use computer_dialog to accept or dismiss it.`,
    ],
  };
}

/**
 * Settle, then describe the page an action produced.
 *
 * Follows a window the action opened (the profile's live page moves to it), waits for the page to
 * settle (at most 1.5 s, never network idle), saves any download it started, takes the snapshot the
 * next action's refs come from, and looks for a challenge in every frame. A dialog appearing on the
 * way stops it there and says so, because a page waiting on one runs no script.
 */
async function reportPage(
  botId: string,
  session: BotSession,
  started: { page: Page; pages: ReadonlySet<Page> },
  extras: {
    status?: number;
    loading?: boolean;
    notes?: string[];
    /** What the challenge check is told: the turn that asked, and Cloudflare's own header. */
    challenge?: { toolCallId?: string; cfMitigated?: string | null };
  } = {},
): Promise<{ page: ReportedPage; challenge?: BrowserChallenge }> {
  const watch = dialogs.next(botId);
  try {
    /*
     * The page the action ran on settles first: that is also the moment a window it opened arrives
     * (Playwright reports it a beat after the click resolves), so the live page is asked after.
     */
    const startedAt = Date.now();
    if (!started.page.isClosed() && !dialogs.pending(botId))
      await Promise.race([
        settlePage(started.page),
        watch.opened.then(() => undefined),
      ]);
    const live = await currentPage(botId);
    const opened =
      live !== started.page && !started.pages.has(live)
        ? { url: live.url() }
        : undefined;
    const pending = dialogs.pending(botId);
    if (pending)
      return {
        page: frozenPage(session, live, pending, {
          ...(extras.status !== undefined ? { status: extras.status } : {}),
          ...(opened ? { opened } : {}),
        }),
      };
    const report = async (): Promise<{
      page: ReportedPage;
      challenge?: BrowserChallenge;
    }> => {
      if (live !== started.page)
        await settlePage(live, Math.max(300, 1_500 - (Date.now() - startedAt)));
      const saved = downloads.started(botId)
        ? await downloads.take(botId)
        : { notes: [] as string[] };
      const previous = session.lastSnapshot;
      const snapshot = await snapshotWhileMoving(session, live);
      if (!snapshot)
        return {
          page: {
            url: live.url(),
            title: "",
            ...(extras.status !== undefined ? { status: extras.status } : {}),
            snapshotId: session.snapshotId,
            elements: [],
            ...(opened ? { opened } : {}),
            ...(saved.download ? { download: saved.download } : {}),
            loading: true as const,
            notes: [
              ...(extras.notes ?? []),
              ...saved.notes,
              "The page was still changing, so its elements could not be listed. Take a snapshot when it has loaded.",
            ],
          },
        };
      const challenge = await detectChallenge(
        live,
        session.control,
        extras.challenge ?? {},
      ).catch(() => undefined);
      const expired = dialogs.takeExpired(botId);
      const notes = [...(extras.notes ?? []), ...saved.notes];
      return {
        page: {
          url: snapshot.url,
          title: snapshot.title,
          ...(extras.status !== undefined ? { status: extras.status } : {}),
          snapshotId: snapshot.snapshotId,
          ...pageLines(previous, snapshot),
          ...(expired ? { dialog: expired } : {}),
          ...(opened ? { opened } : {}),
          ...(saved.download ? { download: saved.download } : {}),
          ...(extras.loading ? { loading: true as const } : {}),
          ...(notes.length ? { notes } : {}),
          snapshot: {
            elements: snapshot.elements,
            truncated: snapshot.truncated,
          },
        },
        ...(challenge ? { challenge } : {}),
      };
    };
    const reporting = report();
    // Left to finish in the background when a dialog wins the race; its failure is not news.
    reporting.catch(() => undefined);
    const raced = await Promise.race([
      reporting,
      watch.opened.then((dialog) => ({ dialog })),
    ]);
    if ("dialog" in raced)
      return {
        page: frozenPage(session, live, raced.dialog, {
          ...(extras.status !== undefined ? { status: extras.status } : {}),
          ...(opened ? { opened } : {}),
        }),
      };
    return raced;
  } finally {
    watch.cancel();
  }
}

/**
 * Resolve a ref to a locator, refusing anything from a superseded snapshot.
 *
 * `aria-ref=` is a first-party Playwright selector engine, and it is the same one its MCP server uses.
 * The generation check here is the caller-facing half; see the note on `snapshotId` for why both exist.
 */
function locateRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
) {
  if (
    expectedSnapshotId !== undefined &&
    expectedSnapshotId !== session.snapshotId
  ) {
    throw new StaleSnapshotError(
      `That list of elements is out of date: it was taken for snapshot ${expectedSnapshotId} and the page is now at ${session.snapshotId}. Take a new snapshot and use the refs from it.`,
    );
  }
  return target.locator(`aria-ref=${ref}`);
}

/**
 * The element, or a refusal that says what to do about it.
 *
 * A generation check is not an existence check. A ref from
 * the current snapshot that names nothing on the page, because a model invented it or because the
 * page moved on without a new snapshot being taken, passes `locateRef` and then simply waits. The
 * action times out, and the caller gets a generic failure carrying Playwright's internal call log
 * instead of the actionable answer: take a fresh snapshot.
 *
 * `count()` resolves immediately rather than waiting, so a ref that names nothing is refused in
 * milliseconds instead of holding the action open for the full timeout.
 */
async function resolveRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
) {
  const locator = locateRef(session, target, ref, expectedSnapshotId);
  if ((await locator.count()) === 0) {
    throw new StaleSnapshotError(
      `Nothing on this page has the ref ${ref}. Take a new snapshot and use the refs it returns.`,
    );
  }
  return locator;
}

class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** What a person watching is told when the browser they were watching went away. */
const COMPUTER_STOPPED =
  "This computer stopped, so the screen ended. Start it again to carry on watching.";

/** What a person is told when their screen is still opening and they have already started typing. */
const SCREEN_STILL_STARTING =
  "This screen is still starting. Try that again in a moment.";

/** What a person is told when they act on a screen that is no longer theirs, or no longer anything. */
const SCREEN_NO_LONGER_LIVE =
  "This screen is no longer live. Reopen it to carry on watching.";

/** How often the cast checks that it is still showing the page the Bot is on. */
const FOLLOW_INTERVAL_MS = 1_000;

/** What a live-screen socket carries: the Bot whose screen it is showing. */
type StreamData = {
  botId: string;
  recordingId?: string;
  /** Applies this socket's input in the order it arrived. See `message`. */
  applyInput?: (input: string | Buffer) => Promise<void>;
};

/**
 * One message from a live-screen socket: a person's input, applied if they may drive.
 *
 * Called in order, one at a time per socket (see `message` below).
 */
async function applyStreamInput(
  ws: ServerWebSocket<StreamData>,
  raw: string | Buffer,
): Promise<void> {
  const session = sessions.for(ws.data.botId);
  /*
   * Whose screen this is, asked before anything is done with the input.
   *
   * A superseded socket used to dispatch through whatever the session held, so a replaced
   * window's typing landed in the page the current viewer was watching. It heard nothing about
   * it either, because the old missing-viewer check returned before reaching anything that could
   * report, which is why this answers the sender rather than returning quietly.
   *
   * Starting and gone are told apart deliberately. Both own no cast, and answering them the same
   * way tells somebody whose screen is still opening that their session ended.
   */
  const standing = session.viewer.standingOf(ws);
  if (standing.state !== "casting") {
    ws.send(
      JSON.stringify({
        type: "error",
        error:
          standing.state === "starting"
            ? SCREEN_STILL_STARTING
            : SCREEN_NO_LONGER_LIVE,
      }),
    );
    return;
  }
  let message: InputMessage;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    const validated = parseInputMessage(parsed);
    if (!validated.ok) {
      ws.send(JSON.stringify({ type: "error", error: validated.error }));
      return;
    }
    message = validated.message;
  } catch {
    // The validated-but-wrong branch above sends an error frame; unparseable input used to
    // be dropped silently, so a buggy surface saw input "ignored" with no diagnostic.
    ws.send(JSON.stringify({ type: "error", error: "Input is not JSON." }));
    return;
  }
  // A person's input is accepted only while they hold the wheel. The socket being open is not permission:
  // without this check, anything that could reach this port could drive the browser while a Bot
  // was working, which is the one thing the control state exists to prevent.
  //
  // Owning the screen is not permission either, which is why this stands after the ownership
  // question above and not instead of it: the two refuse different things, and the one asked
  // first only decides whether the input has anywhere to land.
  //
  // Refuse with an error so the surface can explain why input is ignored.
  if (!session.control.humanMayDrive()) {
    ws.send(JSON.stringify({ type: "error", error: TAKE_CONTROL_FIRST }));
    return;
  }
  try {
    /*
     * On a desktop the gesture is in screen coordinates and the page is one window among others:
     * it is described only when it lands in this Bot's open browser (see `gestureInPage`), and
     * a browser is never opened just to describe one, so a click on the wallpaper stays a click.
     */
    const recordingPage = !ws.data.recordingId
      ? null
      : DESKTOP
        ? session.livePage && !session.livePage.isClosed()
          ? session.livePage
          : null
        : await currentPage(ws.data.botId);
    const recorded = recordingPage
      ? await describeHumanGesture(recordingPage, message, {
          desktop: Boolean(DESKTOP),
        })
      : null;
    await standing.cast.send(message);
    if (recorded)
      ws.send(
        JSON.stringify({
          type: "demonstration.action",
          recordingId: ws.data.recordingId,
          action: recorded,
        }),
      );
  } catch (error) {
    // Reported rather than swallowed. A dispatch that fails means the person's input did nothing,
    // and they must not be left believing it landed.
    console.error(
      JSON.stringify({
        type: "screencast-input-error",
        message: message.type,
        error: String(error),
      }),
    );
    ws.send(
      JSON.stringify({
        type: "error",
        error: describe(error, "That input could not be applied."),
      }),
    );
  }
}

serve<StreamData>({
  port: PORT,
  ...(RUNTIME.hostname ? { hostname: RUNTIME.hostname } : {}),
  idleTimeout: 120,
  /**
   * The live screen, pushed by Chrome rather than polled.
   *
   * Upgraded here rather than served as HTTP because the whole point is that frames arrive when the
   * page changes and input goes back over the same connection. See screencast.ts for why polling was
   * not good enough once a person had to type into this.
   */
  websocket: {
    async open(ws) {
      const session = sessions.for(ws.data.botId);
      /*
       * Claimed before anything is awaited, and that order is the fix.
       *
       * Below this line the Bot's browser may have to be launched, which takes long enough for a
       * client to connect and go away inside it. A close arriving in that window used to find nothing
       * installed and so did nothing, while this function carried on to install a cast and a 1Hz
       * interval for a socket that had already gone: no second close ever came, and the interval went
       * on relaunching a browser somebody had stopped. With the claim taken first there is always
       * something for that close to release, and everything below goes through the claim and is
       * refused once it is gone.
       */
      const claim = session.viewer.claim(ws, (reason) => {
        try {
          ws.send(JSON.stringify({ type: "error", error: reason }));
        } catch {
          // Best effort. The socket may already be gone, which is not a reason to stop tearing down.
        }
      });
      try {
        const send = (frame: unknown) => {
          // A closed socket starts a fresh cast on the next connection.
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            void session.viewer.release(ws);
          }
        };

        if (DESKTOP && VIRTUAL_DISPLAY) {
          /*
           * The whole display, not the page. The browser is asked for so that its window is on the
           * desktop the person is about to see, but not waited for: the desktop is there already,
           * and the window appears on it when the launch is done. Nothing to follow, either; a
           * desktop does not change when the Bot changes page.
           */
          void currentPage(ws.data.botId).catch(() => undefined);
          const cast = startDesktopCast({
            display: VIRTUAL_DISPLAY.name,
            size: DISPLAY_SIZE,
            onFrame: send,
            stream: DESKTOP_STREAM,
          });
          await claim.install(cast);
          return;
        }

        /*
         * The cast follows the Bot's current page. Re-checking also handles a page being closed
         * underneath us without a listener per page.
         */
        let casting: Page | undefined;
        const attach = async () => {
          const target = await currentPage(ws.data.botId);
          if (target === casting) return;
          const cast = await startScreencast(target, send);
          // The claim stops a cast it refuses, so a launch that lost the screen leaks nothing.
          if (!(await claim.install(cast))) return;
          casting = target;
        };

        await attach();
        const follow = setInterval(() => {
          void attach().catch(() => undefined);
        }, FOLLOW_INTERVAL_MS);
        if (!claim.setFollow(() => clearInterval(follow))) return;
      } catch (error) {
        /*
         * Released before the socket is told, because this path is reachable in exactly the timing
         * the claim exists for. A claim left behind here would keep the session occupied for the life
         * of the process, and the sweep in sessions.ts could never take it: the unbounded growth that
         * function was written to stop, reintroduced by the error path of the fix for it.
         */
        await session.viewer.release(ws);
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "The screen could not be started."),
          }),
        );
        ws.close();
      }
    },

    message(ws, raw) {
      /*
       * In the order sent, one after another (see in-order.ts): describing a gesture for a recording
       * awaits the page, and without this a key's "down" waited while its "up" went straight through,
       * so keys reached the screen out of order and "example.com" arrived as "exampl.co".
       */
      ws.data.applyInput ??= inOrder((input: string | Buffer) =>
        applyStreamInput(ws, input),
      );
      void ws.data.applyInput(raw).catch(() => undefined);
    },

    async close(ws) {
      // Names the socket, so it can only ever give up its own screen. A superseded socket closing
      // after its replacement has started releases nothing; see viewer.ts.
      //
      // `get`, not `for`: a socket closing for a Bot with no session has nothing to release,
      // and creating one here would add a map entry on a teardown path, which is the direction the
      // map is meant to shrink in.
      await sessions.get(ws.data.botId)?.viewer.release(ws);
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);

    /*
     * Nothing below this line happens for an untrusted caller.
     *
     * `/health` is the single exception: it names no Bot, touches no browser and reports nothing but
     * whether this process is up, and a container orchestrator has to be able to ask that without
     * holding a secret.
     *
     * The websocket upgrade is checked here too. A browser cannot set headers on an upgrade, so the
     * stream carries the token as a query
     * parameter the same way it already carries the Bot.
     */
    if (
      !isOpenPath(url.pathname) &&
      !matchesToken(COMPUTER_TOKEN, offeredToken(request.headers, url))
    ) {
      // Says nothing about what is here. A refusal that describes the endpoint it is protecting is a
      // directory listing for whoever is knocking.
      return json({ error: "Not authorised." }, 401);
    }

    // Resolved once per request. Everything below that touches a browser, a takeover or a snapshot
    // goes through this Bot's session, so there is no path where one Bot's call reaches another's.
    const botId = botIdOf(request);

    // Refused here rather than deeper down, because the id names a directory and the API server
    // forwards whatever URL segment a caller typed. `reset` deletes that directory as root.
    // `/health` is exempt for the same reason it is exempt from the token: it names no Bot, and an
    // orchestrator's probe must not fail on a header it never meant to send.
    if (!isOpenPath(url.pathname) && !isPlainBotId(botId)) {
      return json({ error: "That is not a usable bot id." }, 400);
    }
    // The admin network policy, pushed by the server on every change; applied without a restart.
    if (url.pathname === "/egress-policy" && request.method === "PUT")
      return handleEgressPolicyRequest(botId, request);
    const session = sessions.for(botId);

    /*
     * The wheel, asked once for everything that acts.
     *
     * Refused here rather than inside each handler because the handler that forgets is the whole
     * defect: the shell shipped without this check and ran commands underneath a person who had taken
     * the browser at a login wall. `actsOnTheComputer` is the list, and a new acting endpoint is
     * refused by being added to it rather than by remembering to repeat this.
     */
    let releaseAction: (() => void) | undefined;
    /*
     * An action a dialog interrupted is answered before it has wound down; the wheel stays held
     * until it has, so a person cannot take the browser while the rest of it is still running.
     */
    let releaseAfter: Promise<void> | undefined;
    try {
      if (actsOnTheComputer(url.pathname)) {
        const released = session.control.admitBotAction(
          needsFreshLook(url.pathname),
        );
        // A download is accepted only while an action of the Bot's runs, or just after it.
        const ended = mutatesBrowser(url.pathname)
          ? downloads.acting(botId)
          : undefined;
        releaseAction = () => {
          ended?.();
          released();
        };
      }

      if (url.pathname === "/stream") {
        /*
         * The socket carries the Bot in the query because it cannot do it in a header. Every other call here names
         * its Bot in `x-openbot-bot-id`, but a websocket client sends no custom headers on the upgrade,
         * so the stream, and only the stream, also accepts the Bot as a query parameter. The header
         * still wins where there is one.
         */
        const streamBotId = botIdOf(request, url.searchParams.get("bot"));
        if (!isPlainBotId(streamBotId)) {
          return json({ error: "That is not a usable bot id." }, 400);
        }
        const recordingId = url.searchParams.get("recording")?.trim();
        if (recordingId && !/^[a-f0-9-]{36}$/.test(recordingId))
          return json({ error: "Invalid recording identity." }, 400);
        if (
          server.upgrade(request, {
            data: {
              botId: streamBotId,
              ...(recordingId ? { recordingId } : {}),
            },
          })
        )
          return undefined as unknown as Response;
        return json({ error: "Expected a WebSocket upgrade." }, 400);
      }

      /*
       * `/live` stays absent. A page served by this process can only be opened by putting the secret in
       * a URL, where it lands in history and logs. The React app is the guarded way to watch a Bot.
       */

      // Who has the wheel. Polled by the surface alongside the screen, so the person sees the Bot ask
      // for help without having to reload anything.
      if (url.pathname === "/control" && request.method === "GET") {
        return json(
          session.control.get(url.searchParams.get("requestId") ?? undefined),
        );
      }

      // The Bot asking for help. It does not take control: it says it is stuck and why, and a person
      // decides. A Bot that could hand itself to a human could also hand a human a page they never
      // asked to see.
      if (url.pathname === "/control/request" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          reason?: unknown;
          toolCallId?: unknown;
        } | null;
        if (
          body?.toolCallId !== undefined &&
          typeof body.toolCallId !== "string"
        )
          return json({ error: "toolCallId must be a string." }, 400);
        return json(
          session.control.requestHelp(body?.reason, body?.toolCallId),
        );
      }

      // The Bot asking for one value it must not be told. It has already focused the field.
      if (url.pathname === "/control/secret" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          label?: unknown;
          ref?: unknown;
          snapshotId?: unknown;
        } | null;
        try {
          return json(session.control.requestSecret(body ?? {}));
        } catch (error) {
          if (error instanceof ControlRequestError) {
            return json({ error: error.message }, 400);
          }
          throw error;
        }
      }

      /**
       * A person supplying that value.
       *
       * Scoped by the pending request rather than by a control handover: it is usable only while the Bot
       * has actually asked for a secret, and the request is cleared the moment it is answered, so this
       * cannot be used as a general back door to type into the page.
       *
       * The value is typed and forgotten. Not stored on `control`, not returned in the response, not
       * logged. The response says how many characters arrived, which is enough for the surface to
       * confirm something was sent and useless to anybody reading it later.
       *
       * It types and does not submit. Committing a form is a separate action through the gateway and
       * audit trail; secret entry only places the value in the named field.
       */
      if (url.pathname === "/human/secret" && request.method === "POST") {
        const pending = session.control.pendingSecret();
        if (!pending) {
          return json({ error: NO_SECRET_PENDING }, 409);
        }
        const body = (await request.json().catch(() => null)) as {
          text?: unknown;
        } | null;
        if (typeof body?.text !== "string" || !body.text) {
          return json({ error: "A value is required." }, 400);
        }
        try {
          const target = await currentPage(botId);
          // Focus the field the Bot named, and let this throw if it cannot be found. A secret must not
          // be reported as delivered unless a field receives it.
          //
          // No generation check here: a Bot may take another snapshot after asking for a secret, while
          // the ref remains protected by Playwright's `aria-ref` rules.
          //
          // `aria-ref` resolves a ref only against the most recent snapshot, only while the element is
          // still connected, and mints a
          // new ref when an element's role or accessible name changes, so a recycled node cannot
          // inherit an old one. If the ref resolves, it is the field the Bot meant. If it does not,
          // nothing is typed, which is the outcome the generation check existed to guarantee.
          const field = locateRef(session, target, pending.ref, undefined);
          await field.click({ timeout: ACTION_TIMEOUT_MS });
          // Typed into the field, or spread one character per box over a code split into boxes,
          // and marked so the snapshot, screenshots and the live screen never show it back.
          await typeSecretValue(target, field, body.text, ACTION_TIMEOUT_MS);
          const characters = body.text.length;
          // Cleared only after it actually landed, so a failure leaves the request open and the person
          // can try again rather than being told to start over.
          session.control.secretSupplied();
          return json({ supplied: true, characters, url: target.url() });
        } catch (error) {
          if (error instanceof StaleSnapshotError) {
            return json({ error: error.message, stale: true }, 409);
          }
          // The field is gone, which is unretryable, so the request is closed rather than left open.
          // Keeping it open is right for a mistyped value and wrong here: the person would retype their
          // password into the same dead ref for ever. Clearing it also unblocks the Bot, which can see
          // on its next turn that nothing is pending and ask again against a fresh snapshot.
          session.control.secretSupplied("field-gone");
          return json(
            {
              error: describe(
                error,
                "That value could not be entered: the field is no longer on the page. Ask the assistant to request it again.",
              ),
            },
            502,
          );
        }
      }

      /**
       * A person's login, from the private sign-in form, typed by this process.
       *
       * On the acting list, so it is refused while a person holds the wheel. The body is read once,
       * handed to `fillSignIn`, and dropped: not logged, not stored, not returned. The answer says
       * whether a form was submitted and whether a password field is still showing, and every error
       * in it is `fillSignIn`'s own sentence rather than a browser's.
       */
      /**
       * What the Bot's page asks for, before a person is shown a sign-in form: a login, a username
       * alone, a one-time code, or nothing, on which origin, with the site's icon. Reads and marks
       * fields, types nothing, so it is not on the acting list and works while a person holds the
       * wheel.
       */
      if (url.pathname === "/sign-in/probe" && request.method === "POST") {
        const target = await currentPage(botId);
        return json(await probeSignIn(target));
      }

      /** A person declining to enter the value the Bot asked for. */
      if (
        url.pathname === "/human/secret/cancel" &&
        request.method === "POST"
      ) {
        if (!session.control.pendingSecret())
          return json({ error: NO_SECRET_PENDING }, 409);
        return json(session.control.cancelSecret());
      }

      if (url.pathname === "/sign-in/fill" && request.method === "POST") {
        const input = parseSignInFill(await request.json().catch(() => null));
        if (typeof input === "string") return json({ error: input }, 400);
        const target = await currentPage(botId);
        const result = await fillSignIn(target, input);
        // The page moved on, so every ref handed out before it is retired, as after a navigation.
        if (result.submitted) session.snapshotId += 1;
        return json(result);
      }

      if (
        ["/control/take", "/control/release", "/control/cancel"].includes(
          url.pathname,
        ) &&
        request.method === "POST"
      ) {
        const body = (await request.json().catch(() => null)) as {
          requestId?: unknown;
        } | null;
        if (typeof body?.requestId !== "string" || !body.requestId.trim())
          return json({ error: "A requestId is required." }, 400);
        if (url.pathname === "/control/take")
          return json(await session.control.take(body.requestId));
        if (url.pathname === "/control/cancel")
          return json(session.control.cancel(body.requestId));
        return json(session.control.release(body.requestId));
      }

      // A person's input, by pixel. The Bot addresses elements by reference because it reads a list; a
      // person addresses them by pointing, because they are looking at a picture. Different problem,
      // different endpoint, and only usable while they hold the wheel.
      if (HUMAN_INPUT.has(url.pathname) && request.method === "POST") {
        if (!session.control.humanMayDrive()) {
          return json({ error: TAKE_CONTROL_FIRST }, 409);
        }
        const body = (await request.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        if (url.pathname === "/human/scroll") {
          const parsed = parseScrollDelta(body?.deltaY);
          if (!parsed.ok) {
            return json({ error: parsed.error }, 400);
          }
        }
        /*
         * In screen space: Clicky carrying out what the person approved, at a point on the desktop
         * rather than in the page, through the same XTEST pointer and keyboard as the person's own
         * hands on the live screen. Behind the same wheel check as above.
         */
        if (body?.space === "screen") {
          if (!DESKTOP || !VIRTUAL_DISPLAY)
            return json(
              { error: "Screen input needs a computer with a desktop." },
              400,
            );
          try {
            return json(
              await performScreenInput(
                await screenInputFor(VIRTUAL_DISPLAY.name),
                url.pathname,
                body,
                session.livePage?.url() ?? "",
                windowChecks(VIRTUAL_DISPLAY.name, botId),
              ),
            );
          } catch (error) {
            return json(
              { error: describe(error, "That did not work.") },
              isRequestError(error) ? 400 : 502,
            );
          }
        }
        try {
          const target = await currentPage(botId);
          return json(
            await performHumanInput(target, url.pathname, body ?? {}),
          );
        } catch (error) {
          return json({ error: describe(error, "That did not work.") }, 502);
        }
      }

      if (url.pathname === "/health") {
        // A browser that exited without Playwright noticing is not reported as running.
        await profiles.forgetIfGone(botId);
        const [profile] = profiles.summary([botId]);
        const lastUsedAt = profiles.lastUsedAt();
        return json({
          status: "ok",
          // `browser` kept as it was: it is in the published contract and start.sh reads it.
          browser: profile?.running ?? false,
          profile,
          // When any Bot's browser was last asked for, so the API can keep the machine awake while
          // a Bot is still working in it. Null with no browser running.
          browserLastUsedAt: lastUsedAt
            ? new Date(lastUsedAt).toISOString()
            : null,
          // Which Bot this computer can prove it is, when the deployment runs SPIRE. Null is a
          // deployment without it, not a failure, and it is reported rather than omitted so the
          // difference between "no identity here" and "identity broken" is visible.
          identity: await identity(),
          browserMode: BROWSER_MODE,
          browserBackend: RUNTIME.backend,
          browserChannel: RUNTIME.channel,
          // The screen the live view shows, when it is a desktop rather than a page. Null is a
          // computer without one, which is the default, not a failure.
          desktop: DESKTOP
            ? {
                width: DISPLAY_SIZE.width,
                height: DISPLAY_SIZE.height,
                ready: DESKTOP.ready,
              }
            : null,
        });
      }

      /**
       * Which run of this Bot's browser the caller is looking at.
       *
       * The server orders snapshots on `(run, generation)`, and the generation alone cannot carry it:
       * this process mints one at zero for every session that is new, so a restart, a redeploy, an
       * eviction from the idle sweep and a reset all produce a page at generation one that looks older
       * than the page the server still has. Ordering on the run as well is what lets the fresh one land
       * and the dead one stop resolving.
       *
       * A read, and deliberately not on the acting list: a person holding the wheel must not turn every
       * ref the server holds into an unanswerable question.
       *
       * Its own endpoint rather than a field on `/computers`, because that one reads the profile
       * directory and this is asked on the path of every governed action.
       */
      if (url.pathname === "/run" && request.method === "GET") {
        return json({ run: session.run });
      }

      /**
       * Start this Bot's browser if it is not running, and go nowhere.
       *
       * The app asks for it the moment a person opens a conversation with a Bot, so the cold launch
       * (seconds on a small machine) is spent while they type rather than after they press send.
       * Not on the acting list: it changes no page, and a person holding the wheel loses nothing.
       */
      /**
       * Where going back in the current tab would lead, read without going there, so the server can
       * decide `computer_back` on its destination. A read: not on the acting list.
       */
      if (url.pathname === "/history" && request.method === "GET") {
        try {
          const target = await currentPage(botId);
          const back = await previousEntry(target);
          return json(back ? { back } : {});
        } catch (error) {
          return json(
            { error: describe(error, "The tab's history could not be read.") },
            502,
          );
        }
      }

      if (url.pathname === "/warm" && request.method === "POST") {
        const startedAt = Date.now();
        const wasRunning = profiles.isLive(botId);
        try {
          const page = await profiles.page(botId);
          lastBrowserBot = botId;
          sessions.observeBrowser(botId, page.context());
          return json({
            warm: true,
            launched: !wasRunning,
            ms: Date.now() - startedAt,
          });
        } catch (error) {
          return json(
            { error: describe(error, "The browser could not be started.") },
            502,
          );
        }
      }

      /**
       * The computers this process holds. The shape is a list because the admin surface is a
       * list, and because a Bot that has a profile has a computer whether or not a browser is running
       * for it this second.
       */
      if (url.pathname === "/computers" && request.method === "GET") {
        return json({ computers: profiles.summary(await profiles.known()) });
      }

      /**
       * Stop the browser, keep what it knows.
       *
       * Closed gracefully so Chromium flushes its profile, and deliberately
       * not restarted here: the next request starts it again, which is the same path as a first ever
       * start, so there is no second way for a browser to come into existence.
       */
      if (url.pathname === "/computers/stop" && request.method === "POST") {
        const wasRunning = await profiles.stop(botId);
        session.control.interrupt(
          "The computer stopped; the previous task was interrupted.",
        );
        return json({ stopped: true, wasRunning });
      }

      /**
       * Forget everything and start over.
       *
       * Signs the computer out of everything by deleting the profile. Irreversible, which is why it is
       * its own endpoint rather than a flag on the one above: a person clicking "stop" must not be able
       * to discard a login by mistyping a parameter.
       */
      if (url.pathname === "/computers/reset" && request.method === "POST") {
        await profiles.reset(botId);
        session.control.interrupt(
          "The computer was reset; the previous task was interrupted.",
        );
        /*
         * And a new run, because the browser this session described is gone.
         *
         * Nothing else here says so. The entry stays in the map and the generation counter carries on,
         * so a snapshot that was in flight when the wipe landed arrives at the server carrying the same
         * run and the same generation as the fresh browser's would: the server deletes its row on
         * reset, the late save inserts the wiped page straight back, and every ref on it goes on
         * resolving. A new run is what makes those two distinguishable at the far end.
         */
        sessions.renewRun(botId);
        return json({ reset: true, botId });
      }

      if (url.pathname === "/navigate" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          url?: unknown;
          toolCallId?: unknown;
        } | null;
        const parsed = parseNavigateUrl(body?.url);
        if (!parsed.ok) {
          return json({ error: parsed.error }, 400);
        }

        const startedAt = Date.now();
        try {
          const target = await currentPage(botId, "navigate");
          session.control.assertBotMayAct(true);
          const frozen = dialogs.pending(botId);
          if (frozen) return dialogOpen(frozen);
          // In front of the person watching before it moves: behind another window, or in a tab
          // that is not the shown one, the whole visit happens where nobody can see it.
          await profiles.bringForward(target);
          /*
           * A sign-in pop-up the site opened is the live page until it closes. Navigating inside it
           * strands the sign-in, so the Bot is told where it is rather than stopped: it may mean it.
           */
          const warning = (await target.opener().catch(() => null))
            ? "You navigated inside a pop-up window the site opened (often a sign-in window). The page that opened it is still open in another tab; use computer_tabs to go back to it, or close this one."
            : undefined;
          const before = {
            page: target,
            pages: new Set(target.context().pages()),
          };
          let response: Awaited<
            ReturnType<typeof navigateWebPage>
          >["response"] = null;
          let stillLoading = false;
          try {
            ({ response, stillLoading } = await dialogs.leaving(botId, () =>
              navigateWebPage(
                target,
                parsed.url,
                RUNTIME.backend,
                NAVIGATION_TIMEOUT_MS,
              ),
            ));
          } catch (error) {
            // An address that is a file download is not a failed navigation: the file is saved.
            if (
              !(isSiteFailure(error) && error.problem === "aborted") ||
              !downloads.started(botId)
            )
              throw error;
          }
          // A new document wipes every stamp, so every ref handed out before now is meaningless.
          // Bumping the generation makes an action carrying one fail with "take a new snapshot" rather
          // than fall through to a selector that matches nothing and read as a missing element.
          session.snapshotId += 1;
          const status = response?.status();
          const reported = await reportPage(botId, session, before, {
            ...(status !== undefined ? { status } : {}),
            ...(stillLoading ? { loading: true } : {}),
            challenge: {
              cfMitigated: response
                ? await response.headerValue("cf-mitigated").catch(() => null)
                : undefined,
              ...(typeof body?.toolCallId === "string"
                ? { toolCallId: body.toolCallId }
                : {}),
            },
          });
          const live = await currentPage(botId, "navigate");
          const extract =
            reported.page.dialog && !reported.page.dialog.dismissed
              ? { text: "", truncated: false }
              : // A page still moving has no text to give yet; the page report says it is loading.
                await readablePageText(live, NAVIGATE_TEXT_LIMIT).catch(() => ({
                  text: "",
                  truncated: false,
                }));
          const challenge = reported.challenge;
          return json({
            url: reported.page.url,
            title: reported.page.title,
            text: extract.text,
            truncated: extract.truncated,
            // Said to the Bot in words, so it reads what is there rather than navigating again.
            ...(stillLoading
              ? {
                  stillLoading: true,
                  note: "The page had not finished loading. This is what it showed so far; read or snapshot it rather than opening it again.",
                }
              : {}),
            ...(warning ? { warning } : {}),
            elapsedMs: Date.now() - startedAt,
            ...(challenge ? { challenge } : {}),
            page: reported.page,
          });
        } catch (error) {
          if (
            error instanceof ControlError ||
            error instanceof SnapshotRequiredError
          )
            throw error;
          // The page is the Bot's working surface, so a failed navigation is reported rather than
          // thrown: the transcript needs to say what happened, and the browser stays usable.
          const site = isSiteFailure(error) ? error : siteFailureOf(error);
          if (site)
            return json(
              {
                error: site.message,
                siteError: { problem: site.problem, code: site.code },
              },
              502,
            );
          return json({ error: describe(error, "Navigation failed.") }, 502);
        }
      }

      /*
       * The desktop as a picture, for the panel's inline preview. Not what the Bot is handed: its
       * `/screenshot` stays a picture of its page, masked, which is what its tools reason about.
       */
      if (url.pathname === "/desktop/screenshot" && request.method === "GET") {
        if (!DESKTOP || !VIRTUAL_DISPLAY) {
          return json(
            {
              error:
                "This computer has no desktop. Set COMPUTER_DESKTOP=on to run one.",
            },
            404,
          );
        }
        try {
          /*
           * `?width=` scales the picture down (a phone's thumbnail). The size it reports stays the
           * screen's, as the live stream's frames do, so whatever is placed on it is in screen pixels.
           */
          const wanted = url.searchParams.has("width")
            ? frameWidthFrom(url.searchParams.get("width"), {
                fallback: DISPLAY_SIZE.width,
                min: 160,
                max: 1440,
              })
            : DISPLAY_SIZE.width;
          const fit = fitWidth(DISPLAY_SIZE, wanted);
          const frame = await captureDesktopFrame(
            VIRTUAL_DISPLAY.name,
            DISPLAY_SIZE,
            undefined,
            fit.scale < 1 ? fit : null,
          );
          return json({
            base64: frame.toString("base64"),
            width: DISPLAY_SIZE.width,
            height: DISPLAY_SIZE.height,
            capturedAt: new Date().toISOString(),
            format: "jpeg",
          });
        } catch (error) {
          return json(
            { error: describe(error, "The desktop could not be captured.") },
            502,
          );
        }
      }

      /*
       * Clicky's three questions about the screen: what is on it and where, what is under one point,
       * and a masked picture of it. Read-only, so none of them is in ACTING_PATHS: Clicky looks while
       * the Bot or a person drives. See elements.ts.
       */
      if (url.pathname === "/elements" && request.method === "GET") {
        try {
          const page = await livePageOf(botId);
          if (!page) {
            if (DESKTOP) return json(emptyScreen(DISPLAY_SIZE));
            return json({ error: BROWSER_NOT_OPEN }, 409);
          }
          const found = await listScreenElements(
            page,
            DESKTOP ? DISPLAY_SIZE : null,
          );
          knownElements.set(botId, found);
          return json(found);
        } catch (error) {
          return json(
            { error: describe(error, "The screen could not be read.") },
            502,
          );
        }
      }

      if (url.pathname === "/elements/at" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          x?: unknown;
          y?: unknown;
          verifyWindow?: unknown;
        } | null;
        if (
          typeof body?.x !== "number" ||
          !Number.isFinite(body.x) ||
          typeof body?.y !== "number" ||
          !Number.isFinite(body.y)
        )
          return json({ error: "A point needs numeric x and y." }, 400);
        const point = { x: body.x, y: body.y };
        /*
         * `verifyWindow`: move the pointer there and ask the X server which window it is over, just
         * before Clicky acts there. Moving the pointer is input, so only for whoever holds the wheel.
         * Without it, the keyboard's window stands in: a page whose window lacks the keyboard may be
         * under another one.
         */
        const verify = body.verifyWindow === true;
        if (verify && !session.control.humanMayDrive())
          return json({ error: TAKE_CONTROL_FIRST }, 409);
        try {
          const page = await livePageOf(botId);
          if (!page) {
            if (DESKTOP)
              return json({
                role: "desktop",
                name: "",
                sensitive: false,
                submits: false,
                opaque: false,
                inPage: false,
                url: "",
                window: "other",
              });
            return json({ error: BROWSER_NOT_OPEN }, 409);
          }
          const display = VIRTUAL_DISPLAY;
          return json(
            await elementAtScreen(
              page,
              DESKTOP ? DISPLAY_SIZE : null,
              point,
              knownElements.get(botId),
              DESKTOP && display
                ? async () => {
                    const pid = await browserPid(profiles.directory(botId));
                    if (!verify) return focusedWindow(display.name, pid);
                    const pointer = await screenInputFor(display.name);
                    await pointer.move(
                      Math.round(point.x),
                      Math.round(point.y),
                    );
                    // A moment for the X server to settle the pointer before it is asked.
                    await Bun.sleep(40);
                    return windowUnderPointer(display.name, pid);
                  }
                : undefined,
            ),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The screen could not be read.") },
            502,
          );
        }
      }

      // What has the keyboard: the Bot's browser or another window, and which element of its page.
      if (url.pathname === "/elements/focus" && request.method === "GET") {
        try {
          const page = await livePageOf(botId);
          if (!page && !DESKTOP) return json({ error: BROWSER_NOT_OPEN }, 409);
          const display = VIRTUAL_DISPLAY;
          const window =
            DESKTOP && display
              ? page
                ? await focusedWindow(
                    display.name,
                    await browserPid(profiles.directory(botId)),
                  )
                : "other"
              : "browser";
          return json(await focusOn(page, window));
        } catch (error) {
          return json(
            { error: describe(error, "The screen could not be read.") },
            502,
          );
        }
      }

      if (url.pathname === "/elements/frame" && request.method === "GET") {
        const width = frameWidthFrom(url.searchParams.get("width"), {
          fallback: 1280,
          min: 160,
          max: 1920,
        });
        try {
          const page = await livePageOf(botId);
          if (!page && !DESKTOP) return json({ error: BROWSER_NOT_OPEN }, 409);
          const display = VIRTUAL_DISPLAY;
          return json(
            await maskedFrame({
              page,
              desktop: DESKTOP && display ? DISPLAY_SIZE : null,
              width,
              captureDesktop: (scale, keep) =>
                captureDesktopFrame(
                  display?.name ?? "",
                  DISPLAY_SIZE,
                  undefined,
                  scale,
                  keep,
                ),
            }),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The screen could not be captured.") },
            502,
          );
        }
      }

      if (url.pathname === "/screenshot" && request.method === "GET") {
        try {
          const target = await currentPage(botId);
          // Sensitive fields are masked in the picture the Bot is handed. See secret-masking.ts.
          const buffer = await target.screenshot({
            type: "png",
            mask: [target.locator(SENSITIVE_FIELD_SELECTOR)],
          });
          // No fixed viewport on a desktop: the window decides, so the page is asked.
          const size =
            target.viewportSize() ??
            (await target
              .evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight,
              }))
              .catch(() => DISPLAY_SIZE));
          return json({
            base64: buffer.toString("base64"),
            width: size.width,
            height: size.height,
            capturedAt: new Date().toISOString(),
            // Which page this is a picture of. A browser that has not been sent anywhere sits on
            // `about:blank`, and a screenshot of that is a valid, entirely white PNG, indistinguishable
            // from a real page to anything looking only at the bytes. The transcript needs to tell
            // those apart to avoid presenting a blank browser as though it were a loaded page.
            url: target.url(),
          });
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error ? error.message : "Screenshot failed.",
            },
            502,
          );
        }
      }

      // The Bot's files. Confined to the workspace by workspace.ts. Nothing here decides whether a Bot
      // MAY touch a path: the gateway in front of this process does that.
      if (url.pathname === "/files/download" && request.method === "GET") {
        try {
          const file = await workspace.download(
            url.searchParams.get("path") ?? "",
          );
          return new Response(file.body, {
            headers: downloadHeaders(file.name, file.bytes),
          });
        } catch (error) {
          return json(
            { error: describe(error, "The file could not be downloaded.") },
            fileStatus(error),
          );
        }
      }

      if (url.pathname === "/files/read" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
        } | null;
        try {
          return json(await workspace.read(String(body?.path ?? "")));
        } catch (error) {
          return json(
            { error: describe(error, "The file could not be read.") },
            fileStatus(error),
          );
        }
      }

      if (url.pathname === "/files/list" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
        } | null;
        try {
          return json(
            await workspace.list(
              typeof body?.path === "string" ? body.path : undefined,
            ),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The folder could not be listed.") },
            fileStatus(error),
          );
        }
      }

      /*
       * A command on this computer.
       *
       * Nothing here decides whether it may run: the gateway already asked the deployment's policy and
       * wrote the audit row before this was called. Refusing again here would be a second, quieter
       * policy nobody configured.
       */
      if (url.pathname === "/exec" && request.method === "POST") {
        if (!RUNTIME.allowExec)
          return json(
            {
              error:
                "Shell execution is disabled for local Chrome. Use the approved host-access tools to run commands on this computer.",
            },
            403,
          );
        const body = (await request.json().catch(() => null)) as {
          command?: unknown;
          timeoutMs?: unknown;
        } | null;
        if (typeof body?.command !== "string" || !body.command.trim()) {
          return json({ error: "A command is required." }, 400);
        }
        const timeout = parseExecTimeout(body.timeoutMs);
        if (!timeout.ok) {
          return json({ error: timeout.error }, 400);
        }
        try {
          return json(
            await shell.run({
              command: body.command,
              ...(timeout.timeoutMs !== undefined
                ? { timeoutMs: timeout.timeoutMs }
                : {}),
              signal: request.signal,
            }),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The command could not be run.") },
            500,
          );
        }
      }

      if (url.pathname === "/files/write" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
          contents?: unknown;
          append?: unknown;
        } | null;
        if (typeof body?.contents !== "string") {
          return json({ error: "The contents to write are required." }, 400);
        }
        try {
          return json(
            await workspace.write(String(body?.path ?? ""), body.contents, {
              append: body.append === true,
            }),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The file could not be written.") },
            fileStatus(error),
          );
        }
      }

      // The current page as text, without navigating anywhere.
      //
      // Reading must be available after actions too. Returning page text only from `/navigate` would be enough if
      // opening a page were the only way to change what is on screen. It is not: the Bot presses
      // "Submit order", the page becomes a confirmation, and it has no way to find out what the
      // confirmation said. "I clicked the button" is not an answer to what happened.
      if (url.pathname === "/read" && request.method === "GET") {
        try {
          const target = await currentPage(botId);
          const frozen = dialogs.pending(botId);
          if (frozen) return dialogOpen(frozen);
          const wanted = readWait(url.searchParams);
          const waited = wanted
            ? await waitForPageText(
                () => readablePageText(target, TEXT_EXTRACT_LIMIT),
                wanted,
              )
            : undefined;
          const extract =
            waited?.extract ??
            (await readablePageText(target, TEXT_EXTRACT_LIMIT));
          return json({
            url: target.url(),
            title: await target.title(),
            text: extract.text,
            truncated: extract.truncated,
            ...(waited && wanted
              ? {
                  waited: {
                    for: wanted.text,
                    found: waited.found,
                    ms: waited.ms,
                  },
                }
              : {}),
            challenge: await detectChallenge(target, session.control),
          });
        } catch (error) {
          return json(
            { error: describe(error, "Reading the page failed.") },
            502,
          );
        }
      }

      // The list of things on the page a Bot can act on. POST rather than GET because it mutates the
      // page, stamping every element it describes, and a GET that changes the document is a lie that
      // caches and prefetchers eventually punish.
      if (url.pathname === "/snapshot" && request.method === "POST") {
        try {
          const target = await currentPage(botId);
          const frozen = dialogs.pending(botId);
          if (frozen) return dialogOpen(frozen);
          const snapshot = await snapshotPage(session, target);
          return json({
            ...snapshot,
            challenge: await detectChallenge(target, session.control),
          });
        } catch (error) {
          return json({ error: describe(error, "Snapshot failed.") }, 502);
        }
      }

      if (ACTIONS.has(url.pathname) && request.method === "POST") {
        const body = (await request
          .json()
          .catch(() => null)) as ActionBody | null;
        if (!body) {
          return json({ error: "An action needs a JSON body." }, 400);
        }
        if (url.pathname === "/scroll") {
          const parsed = parseScrollDelta(body.deltaY);
          if (!parsed.ok) {
            return json({ error: parsed.error }, 400);
          }
        }

        const startedAt = Date.now();
        try {
          const target = await currentPage(botId);
          session.control.assertBotMayAct(true);
          // A page waiting on a dialog runs no script: every other action would hang on it.
          const frozen = dialogs.pending(botId);
          if (frozen && url.pathname !== "/dialog" && url.pathname !== "/tabs")
            return dialogOpen(frozen);
          const before = {
            page: target,
            pages: new Set(target.context().pages()),
          };
          const detail: ActionDetail = { action: url.pathname.slice(1) };
          const observed = await observeAction(
            dialogs,
            botId,
            target,
            (interrupted) =>
              performAction(
                botId,
                session,
                target,
                url.pathname,
                body,
                detail,
                // The caller going away is the stop signal: the surface aborts its request, the server
                // aborts the one it made to this computer, and Bun aborts this one in turn. A dialog
                // the action raised stops the rest of it the same way.
                AbortSignal.any([request.signal, interrupted]),
              ),
          );
          releaseAfter = observed.settled;
          const reported = observed.dialog
            ? {
                page: frozenPage(session, target, observed.dialog, {
                  ...(observed.status !== undefined
                    ? { status: observed.status }
                    : {}),
                }),
              }
            : await reportPage(botId, session, before, {
                ...(observed.status !== undefined
                  ? { status: observed.status }
                  : {}),
                ...(detail.loading ? { loading: true } : {}),
                ...(detail.notes?.length ? { notes: detail.notes } : {}),
              });
          const { notes: _notes, loading: _loading, ...shown } = detail;
          return json({
            ...shown,
            url: reported.page.url,
            ...("challenge" in reported && reported.challenge
              ? { challenge: reported.challenge }
              : {}),
            page: reported.page,
            elapsedMs: Date.now() - startedAt,
          });
        } catch (error) {
          /*
           * Stopped, not failed. The signal is checked rather than the error text: Playwright words an
           * abort differently per call, and the caller's own request going away is the fact that
           * matters either way.
           *
           * Logged because the response is not observed after the caller aborts. The log distinguishes
           * "stopped in time" from "ran to completion after cancellation".
           */
          if (
            error instanceof ControlError ||
            error instanceof SnapshotRequiredError
          )
            throw error;
          if (request.signal.aborted) {
            console.info(
              JSON.stringify({
                type: "action-stopped",
                action: url.pathname,
                ref: typeof body.ref === "string" ? body.ref : undefined,
                elapsedMs: Date.now() - startedAt,
              }),
            );
            // 499, the convention for a client that closed the request: this is not the computer
            // failing, and a 502 here would be counted as one.
            return json({ error: "Stopped.", stopped: true }, 499);
          }
          return actionFailure(error);
        }
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof ControlError) {
        const state = session.control.get();
        return json(
          {
            error: error.message,
            humanHasControl: true,
            requestId: state.request?.id,
            handoff: state.request,
          },
          409,
        );
      }
      if (error instanceof SnapshotRequiredError)
        return json(
          { error: error.message, stale: true, snapshotRequired: true },
          409,
        );
      if (error instanceof ControlRequestError)
        return json(
          { error: error.message, controlRequestError: true },
          error.status,
        );
      throw error;
    } finally {
      const release = releaseAction;
      if (release && releaseAfter) void releaseAfter.then(release, release);
      else release?.();
    }
  },
});

type ActionBody = {
  /** For `/back`: the page the server decided going back would reach. */
  expectedUrl?: unknown;
  ref?: unknown;
  snapshotId?: unknown;
  text?: unknown;
  key?: unknown;
  deltaY?: unknown;
  submit?: unknown;
  option?: unknown;
  checked?: unknown;
  path?: unknown;
  accept?: unknown;
  action?: unknown;
  index?: unknown;
  fields?: unknown;
  then?: unknown;
};

/** What an acting call reports about itself, beside the page it produced. */
type ActionDetail = Record<string, unknown> & {
  action: string;
  /** Said on the page instead of here: a download still saving, a slow page. */
  notes?: string[];
  /** The page had not finished loading when the wait ran out. */
  loading?: boolean;
};

const ACTIONS = new Set([
  "/click",
  "/type",
  "/key",
  "/scroll",
  "/select",
  "/check",
  "/upload",
  "/hover",
  "/fill",
  "/dialog",
  "/tabs",
  "/back",
]);

const HUMAN_INPUT = new Set([
  "/human/click",
  "/human/type",
  "/human/key",
  "/human/scroll",
]);

/**
 * Carry out one thing a person did with their mouse or keyboard.
 *
 * Coordinates are viewport pixels, which the surface works out from the screenshot it is displaying:
 * it knows the image's natural size and the size it drew it at, so it can scale a click back. Doing
 * that conversion in the browser rather than here keeps this endpoint bound to page coordinates
 * rather than window coordinates.
 *
 * Nothing a person types here reaches the model. It goes from their keyboard to this browser and
 * stops. That is what makes a password or a one-time code safe to enter during a takeover: not a
 * filter that strips it out afterwards, but a path the model is not on. The same reason the value is
 * never returned and never logged below.
 */
async function performHumanInput(
  target: Page,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const at = (): { x: number; y: number } => {
    const x = typeof body.x === "number" ? body.x : Number.NaN;
    const y = typeof body.y === "number" ? body.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("A click needs an x and a y inside the page.");
    }
    // Clamped rather than rejected. A click a pixel outside the viewport is a rounding artefact of
    // scaling the screenshot, not a mistake worth refusing.
    const bounds = target.viewportSize() ?? DISPLAY_SIZE;
    return {
      x: Math.min(Math.max(x, 0), bounds.width - 1),
      y: Math.min(Math.max(y, 0), bounds.height - 1),
    };
  };

  if (action === "/human/click") {
    const { x, y } = at();
    await target.mouse.click(x, y, {
      ...(body.button === "right" ? { button: "right" as const } : {}),
      ...(body.double === true ? { clickCount: 2 } : {}),
    });
    return { action: "human_click", url: target.url() };
  }

  if (action === "/human/type") {
    if (typeof body.text !== "string") {
      throw new Error("Typing needs text.");
    }
    // `insertText` rather than per-key typing: a person pasting a one-time code should not have it
    // arrive one character at a time into a field that reformats as you go.
    await target.keyboard.insertText(body.text);
    // Length only, never the value. See the note above about the model not being on this path.
    return {
      action: "human_type",
      characters: body.text.length,
      url: target.url(),
    };
  }

  if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name.");
    }
    await target.keyboard.press(body.key);
    return { action: "human_key", key: body.key, url: target.url() };
  }

  const parsed = parseScrollDelta(body.deltaY);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const deltaY = parsed.deltaY ?? 400;
  // A wheel turns whatever is under the pointer: with a point, the pointer goes there first, so an
  // inner panel scrolls rather than the page around it.
  if (typeof body.x === "number" && typeof body.y === "number") {
    const { x, y } = at();
    await target.mouse.move(x, y);
  }
  await target.mouse.wheel(0, deltaY);
  return { action: "human_scroll", deltaY, url: target.url() };
}

/**
 * Carry out one input in screen pixels on the desktop, as Clicky does for a person who approved it.
 *
 * The same XTEST pointer and keyboard the live screen drives (`x-input.ts`), so it reaches whatever
 * is under the point, the browser's toolbar included, exactly as the person's own click would. Like
 * the page path, nothing typed is returned: a length, never the text.
 */
/** Which window the pointer is over and which has the keyboard, against this Bot's browser. */
function windowChecks(display: string, botId: string) {
  const pid = () => browserPid(profiles.directory(botId));
  return {
    pointer: async () => windowUnderPointer(display, await pid()),
    focus: async () => focusedWindow(display, await pid()),
  };
}

/** Said when the input would have gone to another window than the one the person approved. */
const NOT_THE_BROWSER =
  "That is not the Bot's browser window any more, so nothing was done.";

async function performScreenInput(
  input: XInput,
  action: string,
  body: Record<string, unknown>,
  url: string,
  /**
   * With `requireBrowser` (an action the person approved on the page), the window is asked again
   * at the last moment, after the pointer has moved: another window over the page, or the keyboard
   * gone elsewhere, and nothing is pressed.
   */
  checks?: {
    pointer: () => Promise<"browser" | "other">;
    focus: () => Promise<"browser" | "other">;
  },
): Promise<Record<string, unknown>> {
  const requireBrowser = body.requireBrowser === true && checks !== undefined;
  const onBrowser = async (which: "pointer" | "focus") => {
    if (requireBrowser && (await checks[which]()) !== "browser")
      throw requestError(NOT_THE_BROWSER);
  };
  const point = (): { x: number; y: number } => {
    const x = typeof body.x === "number" ? body.x : Number.NaN;
    const y = typeof body.y === "number" ? body.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw requestError("A click needs an x and a y on the screen.");
    return {
      x: Math.round(Math.min(Math.max(x, 0), DISPLAY_SIZE.width - 1)),
      y: Math.round(Math.min(Math.max(y, 0), DISPLAY_SIZE.height - 1)),
    };
  };

  if (action === "/human/click") {
    const { x, y } = point();
    const button = body.button === "right" ? 3 : 1;
    await input.move(x, y);
    await onBrowser("pointer");
    for (let n = 0; n < (body.double === true ? 2 : 1); n++) {
      await input.button(button, true);
      await input.button(button, false);
    }
    return { action: "human_click", url };
  }

  if (action === "/human/type") {
    if (typeof body.text !== "string") throw requestError("Typing needs text.");
    await onBrowser("focus");
    await input.type(body.text);
    return { action: "human_type", characters: body.text.length, url };
  }

  if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key)
      throw requestError("A key press needs a key name.");
    const keys = xKeysForCombo(body.key);
    if (!keys) throw requestError(`${body.key} is not a key this desktop has.`);
    await onBrowser("focus");
    if (keys.kind === "text") {
      await input.type(keys.text);
    } else {
      for (const keysym of keys.keysyms) await input.key(keysym, true);
      for (const keysym of [...keys.keysyms].reverse())
        await input.key(keysym, false);
    }
    return { action: "human_key", key: body.key, url };
  }

  const parsed = parseScrollDelta(body.deltaY);
  if (!parsed.ok) throw requestError(parsed.error);
  const deltaY = parsed.deltaY ?? 400;
  if (typeof body.x === "number" && typeof body.y === "number") {
    const { x, y } = point();
    await input.move(x, y);
  }
  await onBrowser("pointer");
  for (const click of wheelClicks(0, deltaY))
    for (let n = 0; n < click.times; n++) {
      await input.button(click.button, true);
      await input.button(click.button, false);
    }
  return { action: "human_scroll", deltaY, url };
}

/**
 * Carry out one action on the page.
 *
 * Every action that addresses an element goes through {@link resolveRef}, so the staleness check
 * cannot be forgotten at a call site. `/key` and `/scroll` may omit a ref and act on the page itself,
 * which is how a Bot presses Enter to submit or scrolls to bring more of a long form into view.
 *
 * Stop has to reach the browser. `signal` is the caller's request going away, the person pressed
 * Stop, and the abort travels from the surface, through the server, to here. Without passing it on,
 * pressing Stop ended the run in the transcript while the click it was meant to prevent carried on
 * landing on a live page. Stop must reach the browser before a high-impact click lands.
 *
 * Writes what it did into `detail` as it goes rather than returning it, so a fill that a dialog
 * interrupts can still say which fields it had filled.
 */
async function performAction(
  botId: string,
  session: BotSession,
  target: Page,
  action: string,
  body: ActionBody,
  detail: ActionDetail,
  signal?: AbortSignal,
): Promise<void> {
  const options = {
    timeoutMs: ACTION_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
    refFor: refFor(session),
  };
  const expected =
    typeof body.snapshotId === "number" ? body.snapshotId : undefined;
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;
  const roleOf = (wanted: string) =>
    session.lastSnapshot?.elements.find((element) => element.ref === wanted)
      ?.role;
  const element = async (verb: string) => {
    if (!ref) throw requestError(`${verb} needs the ref of an element.`);
    return resolveRef(session, target, ref, expected);
  };

  if (action === "/click") {
    const locator = await element("A click");
    await clickElement(locator, ref as string, roleOf(ref as string), options);
    Object.assign(detail, { ref });
    return;
  }

  if (action === "/type") {
    if (typeof body.text !== "string")
      throw requestError("Typing needs the text to enter.");
    const locator = await element("Typing");
    const outcome = await typeInto(
      target,
      locator,
      ref as string,
      body.text,
      body.submit === true,
      options,
    );
    // The text itself is deliberately NOT returned. It is echoed nowhere: this response is read by
    // the model and logged by the server, and a value typed into a form is exactly where a password
    // or a card number lives. The caller already knows what it sent.
    Object.assign(detail, {
      ref,
      characters: body.text.length,
      submitted: body.submit === true && !outcome.routed,
      ...(outcome.routed
        ? {
            routed: outcome.routed,
            ...(outcome.chosen !== undefined ? { chosen: outcome.chosen } : {}),
            note: `${ref} is not a text field, so this was done with ${outcome.routed} instead. Use ${outcome.routed} for it next time.`,
          }
        : {}),
    });
    return;
  }

  if (action === "/key") {
    if (typeof body.key !== "string" || !body.key)
      throw requestError("A key press needs a key name, such as Enter or Tab.");
    const key = body.key;
    if (ref) {
      const locator = await element("A key press");
      await guarded(locator, ref, "press a key on", options, (abort) =>
        locator.press(key, { timeout: ACTION_TIMEOUT_MS, signal: abort }),
      );
    } else {
      await target.keyboard.press(key);
    }
    Object.assign(detail, { key, ...(ref ? { ref } : {}) });
    return;
  }

  if (action === "/scroll") {
    const parsed = parseScrollDelta(body.deltaY);
    if (!parsed.ok) throw requestError(parsed.error);
    if (ref) {
      // Into view, or inside the panel it is in: a page-level wheel never moves an inner panel.
      const locator = await element("Scrolling to an element");
      const moved = await scrollElement(locator, ref, parsed.deltaY, options);
      Object.assign(detail, {
        ref,
        ...(parsed.deltaY !== undefined ? { deltaY: parsed.deltaY } : {}),
        ...moved,
      });
      return;
    }
    // A plain wheel event on the page, which is what moves a long form.
    const deltaY = parsed.deltaY ?? 600;
    await target.mouse.wheel(0, deltaY);
    Object.assign(detail, { deltaY });
    return;
  }

  if (action === "/select") {
    if (typeof body.option !== "string" || !body.option.trim())
      throw requestError(
        "Say which option to choose, by its label or its value.",
      );
    const locator = await element("Choosing an option");
    const { chosen } = await chooseOption(
      target,
      locator,
      ref as string,
      body.option,
      options,
      roleOf(ref as string),
    );
    Object.assign(detail, { ref, chosen });
    return;
  }

  if (action === "/check") {
    if (typeof body.checked !== "boolean")
      throw requestError(
        "Say whether it should be ticked: checked true or false.",
      );
    const locator = await element("Ticking a box");
    await setChecked(target, locator, ref as string, body.checked, options);
    Object.assign(detail, { ref, checked: body.checked });
    return;
  }

  if (action === "/upload") {
    const full = await uploadPath(body.path);
    const locator = await element("An upload");
    await uploadFile(target, locator, ref as string, full, options);
    Object.assign(detail, { ref, path: String(body.path).trim() });
    return;
  }

  if (action === "/hover") {
    const locator = await element("Hovering");
    await hoverElement(locator, ref as string, options);
    Object.assign(detail, { ref });
    return;
  }

  if (action === "/dialog") {
    if (typeof body.accept !== "boolean")
      throw requestError(
        "Say whether to accept the dialog (OK) or dismiss it (Cancel): accept true or false.",
      );
    if (body.text !== undefined && typeof body.text !== "string")
      throw requestError("A prompt's answer must be text.");
    let answered: DialogInfo;
    try {
      answered = await dialogs.answer(
        botId,
        body.accept,
        typeof body.text === "string" ? body.text : undefined,
      );
    } catch (error) {
      throw elementProblem("no_dialog", describe(error, "No dialog is open."));
    }
    // What it said, never what was typed into a prompt: that is a field like any other.
    Object.assign(detail, {
      accepted: body.accept,
      dialog: { type: answered.type, message: answered.message },
    });
    return;
  }

  if (action === "/tabs") {
    await performTabs(botId, body, detail);
    return;
  }

  if (action === "/back") {
    const from = target.url();
    /*
     * The server decided on the page it was told back would reach. If the tab's history says
     * somewhere else now (another navigation in between), that decision is not about this one.
     */
    if (typeof body.expectedUrl === "string") {
      const previous = await previousEntry(target);
      if (previous?.url !== body.expectedUrl)
        throw new StaleSnapshotError(
          `The page to go back to is no longer ${body.expectedUrl}${previous ? ` but ${previous.url}` : ""}. Ask again to go back.`,
        );
    }
    // In front of the person watching, as for `computer_navigate`.
    await profiles.bringForward(target);
    let response: PageResponse | null = null;
    try {
      response = await dialogs.leaving(botId, () =>
        target.goBack({ waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS }),
      );
    } catch (error) {
      throw siteFailureOf(error) ?? error;
    }
    const wentBack = response !== null || target.url() !== from;
    if (!wentBack) {
      Object.assign(detail, {
        wentBack: false,
        notes: ["There is no earlier page in this tab to go back to."],
      });
      return;
    }
    try {
      await target.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    } catch {
      detail.loading = true;
    }
    session.snapshotId += 1;
    Object.assign(detail, { wentBack: true });
    return;
  }

  // Fill.
  await performFill(session, target, body, detail, options, expected);
}

/** A workspace path, confined by workspace.ts, that must name an existing file. */
async function uploadPath(path: unknown): Promise<string> {
  if (typeof path !== "string" || !path.trim())
    throw new WorkspaceFileError(
      "Say which file to upload, by its path in your workspace.",
    );
  const full = await workspace.resolvePath(path.trim(), false);
  const info = await stat(full);
  if (!info.isFile())
    throw new WorkspaceFileError(`${path.trim()} is a folder, not a file.`);
  return full;
}

/** A page's title, or empty when it does not answer quickly (one paused on a dialog, say). */
async function titleWithin(page: Page, ms = 500): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), ms);
  });
  try {
    return await Promise.race([page.title().catch(() => ""), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** `computer_tabs`: list this browser's tabs, switch to one, or close one. */
async function performTabs(
  botId: string,
  body: ActionBody,
  detail: ActionDetail,
): Promise<void> {
  const which = body.action;
  if (which !== "list" && which !== "switch" && which !== "close")
    throw requestError("Say what to do with the tabs: list, switch or close.");
  const listed = async () => {
    const { pages, live } = profiles.tabs(botId);
    return Promise.all(
      pages.map(async (page, index) => ({
        index,
        url: page.url(),
        title: await titleWithin(page),
        active: page === live,
      })),
    );
  };
  if (which === "list") {
    Object.assign(detail, { tabs: await listed() });
    return;
  }
  const { pages } = profiles.tabs(botId);
  const index = body.index;
  const page =
    typeof index === "number" && Number.isInteger(index)
      ? pages[index]
      : undefined;
  if (!page)
    throw requestError(
      `There is no tab ${String(index)}. The open tabs are numbered 0 to ${pages.length - 1}; list them first.`,
    );
  if (which === "switch") {
    await profiles.activate(botId, page);
  } else {
    // The last tab is the browser: closing it would read as a browser that died, and relaunch.
    if (pages.length === 1)
      throw requestError(
        "This is the only tab. Open another page with computer_navigate instead of closing it.",
      );
    // Bounded: closing a tab on Chromium's own error page now and then never answers.
    await settleWithin(page.close({ runBeforeUnload: false }), 5_000);
  }
  Object.assign(detail, {
    [which === "switch" ? "switched" : "closed"]: index,
    tabs: await listed(),
  });
}

/** Why one field of a fill did not work, in the shape every other acting error has. */
function fieldFailure(error: unknown): Record<string, unknown> {
  if (error instanceof StaleSnapshotError)
    return { error: error.message, stale: true };
  if (isElementProblem(error))
    return {
      error: error.message,
      problem: error.problem,
      ...error.details,
      ...(error.problem === "detached" ? { stale: true } : {}),
    };
  return { error: describe(error, "That field could not be filled.") };
}

/**
 * Fill a whole form in one call, then click or submit when asked. See `fillForm` in acting.ts.
 *
 * The server has already decided and recorded every field (and the click) before this is called,
 * so nothing here is a new decision.
 */
async function performFill(
  session: BotSession,
  target: Page,
  body: ActionBody,
  detail: ActionDetail,
  options: ActingOptions,
  expected: number | undefined,
): Promise<void> {
  const { fields, after } = parseFill(body.fields, body.then);
  const outcome: FillOutcome = { filled: [] };
  detail.filled = outcome.filled;
  try {
    await fillForm(
      target,
      fields,
      after,
      {
        locate: (ref) => resolveRef(session, target, ref, expected),
        roleOf: (ref) =>
          session.lastSnapshot?.elements.find((element) => element.ref === ref)
            ?.role,
        uploadPath,
        failure: fieldFailure,
      },
      options,
      outcome,
    );
  } finally {
    if (outcome.failed) detail.failed = outcome.failed;
    if (outcome.afterwards) detail.afterwards = outcome.afterwards;
  }
}

/** An acting failure as the HTTP answer the server maps onto its own errors. */
function actionFailure(error: unknown): Response {
  // A stale ref is the caller's mistake and is fixable by taking a new snapshot, so it is a 409
  // rather than a 502: the computer is fine and retrying the same call unchanged will not help.
  if (error instanceof StaleSnapshotError)
    return json({ error: error.message, stale: true }, 409);
  if (isRequestError(error))
    return json({ error: describe(error, "That request is malformed.") }, 400);
  if (isElementProblem(error)) {
    // Gone from the page is the one problem a new snapshot fixes.
    if (error.problem === "detached")
      return json({ error: error.message, stale: true }, 409);
    return json(
      { error: error.message, problem: error.problem, ...error.details },
      422,
    );
  }
  if (
    error instanceof WorkspaceFileError ||
    error instanceof WorkspacePathError
  )
    return json({ error: error.message }, fileStatus(error));
  if (isSiteFailure(error))
    return json(
      {
        error: error.message,
        siteError: { problem: error.problem, code: error.code },
      },
      502,
    );
  return json({ error: describe(error, "The action failed.") }, 502);
}

/**
 * A snapshot of a page that may still be navigating: the action's own work is done, so a document
 * replaced under the snapshot is waited for and asked again, and one that will not hold still is
 * answered with nothing rather than turning a click that worked into a failure.
 */
async function snapshotWhileMoving(
  session: BotSession,
  live: Page,
): Promise<Awaited<ReturnType<typeof snapshotPage>> | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await snapshotPage(session, live);
    } catch (error) {
      if (
        !/Execution context was destroyed|navigat|frame was detached|Target page, context or browser has been closed/i.test(
          String(error),
        ) ||
        live.isClosed()
      )
        throw error;
      await live
        .waitForLoadState("domcontentloaded", { timeout: 3_000 })
        .catch(() => undefined);
    }
  }
  return undefined;
}

/** A page paused on a dialog: nothing else can run until it is answered. */
function dialogOpen(dialog: DialogInfo): Response {
  return json(
    {
      error: `A ${dialog.type} dialog is open on the page ("${dialog.message.slice(0, 120)}"). Answer it with computer_dialog (accept or dismiss) before doing anything else.`,
      dialog,
    },
    409,
  );
}

/** An error as one plain sentence: never Playwright's call log. See action-errors.ts. */
function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? summariseError(error.message) : fallback;
}

/**
 * Which status a file failure deserves.
 *
 * A path outside the workspace is the caller asking for something it may never have, so 403: retrying
 * it unchanged will never work, and it is not a fault. A missing download is 404, an oversized
 * download is 413, and an ordinary bad file request is 400, because a different request could
 * succeed. Collapsing these into 500 would tell the caller the computer is broken and invite a retry
 * of the same request.
 */
function fileStatus(error: unknown): 400 | 403 | 404 | 413 | 500 {
  if (error instanceof WorkspacePathError) return 403;
  if (error instanceof WorkspaceFileTooLargeError) return 413;
  if (error instanceof WorkspaceFileNotFoundError) return 404;
  if (error instanceof WorkspaceFileError) return 400;
  return 500;
}

console.info(`agent-computer listening on http://127.0.0.1:${PORT}`);

/**
 * Hand the profile back before dying.
 *
 * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait, so this is the window in
 * which Chromium can flush its profile to the volume. This is the graceful-shutdown path for normal
 * container restarts.
 *
 * `stop_grace_period` in docker-compose.yml is what gives this time to run.
 */
let shuttingDown = false;

async function shutDown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  // Set before the first await: a display exiting while Chromium flushes is part of this shutdown,
  // not a second failure racing it.
  shuttingDown = true;
  console.info(`${reason}: closing the browser so its profile is flushed`);
  await profiles.closeAll();
  BROWSER_REQUESTS?.close();
  await DESKTOP?.stop();
  await VIRTUAL_DISPLAY?.stop();
  process.exit(exitCode);
}

if (VIRTUAL_DISPLAY) {
  void VIRTUAL_DISPLAY.terminated.then(({ code, expected }) => {
    if (expected || shuttingDown) return;
    console.error(
      JSON.stringify({
        type: "computer-virtual-display-exited",
        exitCode: code,
      }),
    );
    // A headed Chromium cannot recover without its display. Let the container restart policy build
    // the pair together again instead of advertising a healthy service whose next browser fails.
    void shutDown("virtual display exited", 1);
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutDown(signal, 0);
  });
}
