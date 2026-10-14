/**
 * The only way an action reaches a Bot's computer.
 *
 * Reading a page is one thing; clicking a button on an external website is
 * another, and the difference is the whole product. The record is not a report written alongside the
 * work, it is the thing the action goes through, so it cannot be missing: an action that was not
 * recorded did not happen, because there is no path that acts without writing the row first.
 *
 * Three jobs, in this order:
 *
 *  1. Resolve the ref the caller sent into the element it actually points at, from the snapshot this
 *     server fetched. Never from what the caller said it was clicking.
 *  2. Ask the policy. Deny beats allow, an absent policy denies, and a broken rule denies.
 *  3. Write the row, whichever way the decision went, and only then act.
 *
 * Step 1 is the one that is easy to skip and fatal to skip. A gateway that decides on a label supplied
 * by the model is theatre: "never click Submit" is evaded by sending `{ref: "e13", name: "Continue"}`.
 * The refs are opaque to the caller precisely so that the server holds the mapping.
 */

import {
  type ApprovalGate,
  type ApprovalPermit,
  currentApprovalContext,
} from "../approvals/types";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import { withUntrustedNotice } from "../untrusted-content";
import {
  ComputerStoppedError,
  ComputerUnavailableError,
  createComputerTransport,
  NavigationRefusedError,
  StaleSnapshotError,
} from "./client";
import { HeadlessToolSuspension } from "./headless-tools";
import { checkComputerAddress, checkNavigationTarget } from "./target";

export {
  ComputerUnavailableError,
  ElementNotFoundError,
  HandoffRequestError,
  HumanHasControlError,
  isDialogOpenError,
  isElementStateError,
  isSiteError,
  NavigationRefusedError,
  NavigationTimeoutError,
  StaleSnapshotError,
  WorkspaceNotFoundError,
  WorkspaceRefusedError,
  WorkspaceRequestError,
  WorkspaceTooLargeError,
} from "./client";

import type { PageFrameStore } from "./page-frames";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
  type PolicyDecision,
  policyInitiator,
} from "./policy";
import type { ComputerProvider, ComputerUpdate } from "./provider";
import type {
  ActionResult,
  CheckInput,
  ClickInput,
  ClickyFrame,
  ComputerStatus,
  ControlState,
  DialogInput,
  DownloadFileInput,
  ElementAtResult,
  FillInput,
  FocusResult,
  FillResult,
  HoverInput,
  HumanInput,
  HumanInputResult,
  KeyInput,
  ListFilesInput,
  ListFilesResult,
  NavigateResult,
  PageReport,
  ReadFileInput,
  ReadFileResult,
  ReadResult,
  RunCommandInput,
  RunCommandResult,
  ScreenshotResult,
  ScreenElements,
  ScrollInput,
  SecretRequest,
  SecretResult,
  SelectInput,
  SignInFillInput,
  SignInFillResult,
  SignInProbe,
  SnapshotElement,
  SnapshotResult,
  TabsInput,
  TypeInput,
  UploadInput,
  WarmResult,
  WriteFileInput,
  WriteFileResult,
} from "./schema";
import {
  createInMemorySnapshotStore,
  type SnapshotStore,
  type StoredSnapshot,
  withWriteThrough,
} from "./snapshot-store";

export class ActionRefusedError extends Error {
  /** The rule that refused it, so the surface can show which one and an operator can find it. */
  readonly rule: string | null;

  constructor(reason: string, rule: string | null) {
    super(reason);
    this.name = "ActionRefusedError";
    this.rule = rule;
  }
}

/** Who is asking. The gateway records this; it does not decide it. */
export type ActionActor = {
  /** The signed-in person, or the local actor when authentication is not configured. */
  id: string;
  /** Null unless this is a real row in `users`, because the audit table has a foreign key to it. */
  userId?: string;
  /** What started this run; scheduled work must not inherit person initiation. */
  initiator?: AuditInitiator;
};

export type ComputerGatewayOptions = {
  approvalGate?: ApprovalGate;
  provider: ComputerProvider;
  auditStore: AuditStore;
  /** Absent denies everything. See evaluateActionPolicy. */
  policy: () => ActionPolicy | undefined;
  /** True on a laptop, where browsing private network addresses is required. */
  allowPrivateHosts?: boolean;
  /** The secret that agent-computer requires on each request. */
  token?: string;
  /** An injectable fetch implementation for focused gateway tests. */
  fetchImpl?: typeof fetch;
  /**
   * Where the snapshot a ref is resolved against is kept.
   *
   * A deployment passes the database-backed store, because the process that takes a snapshot is
   * rarely the one that resolves a ref from it. Absent, the gateway keeps snapshots in memory, which
   * is correct in one process and is what a unit test wants. See snapshot-store.ts.
   */
  snapshots?: SnapshotStore;
  /**
   * Where the frame a page was opened on is kept, so a reset can take them with the profile.
   *
   * Absent, a reset clears the profile and leaves the pictures, which is the wrong half of a promise
   * this deployment makes in as many words.
   */
  pageFrames?: PageFrameStore;
  /**
   * How long a located address is reused before the provider is asked again. Zero asks on every
   * call, as the gateway always did. See `locate`.
   */
  locateCacheMs?: number;
  /** How long the policy read for a Bot is reused. Zero reads it on every action. */
  policyCacheMs?: number;
  /**
   * Told about every handover after its audit row is written: a person asked for, taking control,
   * handing it back, a secret asked for or entered. Clicky listens here so it opens whenever the Bot
   * needs the person, whichever path asked (a browser run, an in-run tool, the private sign-in), and
   * closes when the handover ends. Never awaited and never allowed to throw into the handover: a
   * listener that fails must not cost the person their control of the computer.
   */
  onControlEvent?: (event: ComputerControlEvent) => void;
};

/** One handover moment, as `onControlEvent` hears it. */
export type ComputerControlEvent = {
  type:
    | "help_requested"
    | "help_cancelled"
    | "control_taken"
    | "control_released"
    | "secret_requested"
    | "secret_supplied"
    | "secret_cancelled";
  botId: string;
  /** The person on whose authority it happened, when there is one. */
  userId?: string;
  /** The Bot's own words, for a request. */
  reason?: string;
  toolCallId?: string;
  /**
   * The element the Bot asked the person to use first (`point_at` on a help request), an aria ref
   * from its latest snapshot, so Clicky can point at it. Only on `help_requested`.
   */
  pointAt?: string;
  /** The computer's control state right after it, including the request it is about. */
  state: ControlState;
};

export interface ComputerGateway {
  readonly provider: ComputerProvider;
  /** Where frames of pages are kept, when the deployment keeps them (`computer_show_screen`). */
  readonly pageFrames?: PageFrameStore;
  locate(botId: string): Promise<string>;
  /**
   * `browser: true` also says whether the Bot's browser is running (`ComputerStatus.browser`), for
   * the panel. Off by default: on a computer per Bot it is one more call, and the other callers only
   * want to know whether the computer is up.
   */
  status(
    botId: string,
    options?: { browser?: boolean },
  ): Promise<ComputerStatus>;
  screenshot(botId: string): Promise<ScreenshotResult>;
  /**
   * The whole desktop, for a computer that draws one. The computer answers 404 without one. `width`
   * scales the picture down (a phone's thumbnail); the size it reports stays the screen's.
   */
  desktopScreenshot(
    botId: string,
    options?: { width?: number },
  ): Promise<ScreenshotResult>;
  /**
   * Clicky Mode: the visible controls and their boxes on the screen. Read-only and not governed, like
   * a screenshot: it changes nothing and the Bot's own snapshot is untouched by it.
   */
  elements(botId: string): Promise<ScreenElements>;
  /**
   * Clicky Mode: what is under one screen point, asked of the page now. `verifyWindow` moves the
   * desktop's pointer there and asks which window it is over (only while a person holds control).
   */
  elementAt(
    botId: string,
    point: { x: number; y: number },
    options?: { verifyWindow?: boolean },
  ): Promise<ElementAtResult>;
  /** Clicky Mode: what has the keyboard. */
  focus(botId: string): Promise<FocusResult>;
  /** Clicky Mode: the masked picture its model is shown, no wider than `width`. */
  clickyFrame(botId: string, width: number): Promise<ClickyFrame>;
  /**
   * The boundary in force for a Bot, as the gateway reads it for every action. Clicky checks a
   * person's approved action against its deny rules before carrying it out.
   */
  actionPolicy(botId: string): ActionPolicy | undefined;
  snapshot(botId: string): Promise<SnapshotResult>;
  /** `waitFor`: wait on the page, up to `timeoutMs` (20 s at most), for these words to appear. */
  read(
    botId: string,
    options?: { waitFor?: string; timeoutMs?: number },
  ): Promise<ReadResult>;
  navigate(
    botId: string,
    actor: ActionActor,
    url: string,
    toolCallId?: string,
  ): Promise<NavigateResult>;
  click(
    botId: string,
    actor: ActionActor,
    input: ClickInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  type(
    botId: string,
    actor: ActionActor,
    input: TypeInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  key(
    botId: string,
    actor: ActionActor,
    input: KeyInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  scroll(
    botId: string,
    actor: ActionActor,
    input: ScrollInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  /** Choose an option in a drop-down, native or custom, by its label or value. */
  select(
    botId: string,
    actor: ActionActor,
    input: SelectInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  /** Tick or untick a checkbox, radio button or switch. */
  check(
    botId: string,
    actor: ActionActor,
    input: CheckInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  /** Put a workspace file into an upload control. Governed with the file's path. */
  upload(
    botId: string,
    actor: ActionActor,
    input: UploadInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  hover(
    botId: string,
    actor: ActionActor,
    input: HoverInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  /** Accept or dismiss the JavaScript dialog the page is paused on. */
  dialog(
    botId: string,
    actor: ActionActor,
    input: DialogInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  tabs(
    botId: string,
    actor: ActionActor,
    input: TabsInput,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  back(
    botId: string,
    actor: ActionActor,
    signal?: AbortSignal,
  ): Promise<ActionResult>;
  /**
   * A whole page of fields in one call. Each field is decided and recorded exactly as the
   * single-field tool would be (type, select, check, upload; the `then` as a click or an Enter);
   * a refused field stops the batch there, and the result says which and why.
   */
  fill(
    botId: string,
    actor: ActionActor,
    input: FillInput,
    signal?: AbortSignal,
  ): Promise<FillResult>;
  /** Start the Bot's browser if it is stopped, without navigating. Not an action: nothing is recorded. */
  warm(botId: string): Promise<WarmResult>;
  /** Forget the policy read for a Bot (or every Bot), because the policy changed. */
  invalidatePolicy(botId?: string): void;
  readFile(
    botId: string,
    actor: ActionActor,
    input: ReadFileInput,
  ): Promise<ReadFileResult>;
  downloadFile(
    botId: string,
    actor: ActionActor,
    input: DownloadFileInput,
    signal?: AbortSignal,
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    bytes: number;
    name: string;
  }>;
  listFiles(
    botId: string,
    actor: ActionActor,
    input: ListFilesInput,
  ): Promise<ListFilesResult>;
  runCommand(
    botId: string,
    actor: ActionActor,
    input: RunCommandInput,
    signal?: AbortSignal,
  ): Promise<RunCommandResult>;
  writeFile(
    botId: string,
    actor: ActionActor,
    input: WriteFileInput,
  ): Promise<WriteFileResult>;
  control(botId: string, requestId?: string): Promise<ControlState>;
  requestHelp(
    botId: string,
    actor: ActionActor,
    reason: string,
    toolCallId?: string,
    /** The element the person should use first, for Clicky to point at. */
    options?: { pointAt?: string },
  ): Promise<ControlState>;
  takeControl(
    botId: string,
    actor: ActionActor,
    requestId: string,
  ): Promise<ControlState>;
  releaseControl(
    botId: string,
    actor: ActionActor,
    requestId: string,
  ): Promise<ControlState>;
  cancelControl(
    botId: string,
    actor: ActionActor,
    requestId: string,
  ): Promise<ControlState>;
  requestSecret(
    botId: string,
    actor: ActionActor,
    input: SecretRequest,
  ): Promise<ControlState>;
  supplySecret(
    botId: string,
    actor: ActionActor,
    text: string,
  ): Promise<SecretResult>;
  /** A person declining the value the Bot asked for. Audited without any value. */
  cancelSecret(botId: string, actor: ActionActor): Promise<ControlState>;
  /** What the Bot's page asks for before a sign-in form is shown. Types nothing. */
  probeSignIn(botId: string, signal?: AbortSignal): Promise<SignInProbe>;
  /** Fill and submit a login form on the Bot's current page. See passwords/service.ts. */
  signIn(
    botId: string,
    input: SignInFillInput,
    signal?: AbortSignal,
  ): Promise<SignInFillResult>;
  humanInput(botId: string, input: HumanInput): Promise<HumanInputResult>;
  computers(): Promise<{
    isolation: "per-bot" | "shared";
    computers: {
      botId: string;
      running: boolean;
      startedAt: string | null;
      egress?: string | null;
      updateAvailable?: boolean;
    }[];
  }>;
  stopComputer(
    botId: string,
    actor: ActionActor,
  ): Promise<{ wasRunning: boolean }>;
  resetComputer(
    botId: string,
    actor: ActionActor,
  ): Promise<{ cleared: boolean }>;
  /** Move a computer onto the current image, keeping its files and sign-ins. */
  updateComputer(botId: string, actor: ActionActor): Promise<ComputerUpdate>;
}

export function createComputerGateway(
  options: ComputerGatewayOptions,
): ComputerGateway {
  const { provider, auditStore } = options;
  const transport = createComputerTransport({
    ...(options.token ? { token: options.token } : {}),
    ...(options.allowPrivateHosts !== undefined
      ? { allowPrivateHosts: options.allowPrivateHosts }
      : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  /**
   * Where the snapshot a ref is resolved against lives.
   *
   * Not a `Map` in this process. It describes the live contents of a browser window, and the process
   * that took it is rarely the one that resolves a ref from it: OpenBot is several servers behind a
   * load balancer, and consecutive calls on one conversation land on different ones. Kept in memory,
   * the mapping is absent on every replica but the one that snapshotted, so the ref resolves to
   * nothing, the policy decides with no element in front of it, and the audit row cannot name what
   * was touched. The store puts it in Postgres, and the generation carried on every action keeps a
   * ref from a superseded page from resolving to whatever now holds it. See snapshot-store.ts.
   */
  const snapshots = withWriteThrough(
    options.snapshots ?? createInMemorySnapshotStore(),
  );
  const pageFrames = options.pageFrames;

  /**
   * Where each Bot's computer was last found, kept for {@link LOCATE_CACHE_MS}.
   *
   * Every call used to locate first, and on the supervisor that is an `/ensure` round trip before
   * each screenshot the panel polls, each page read and each page-level action. The answer is the
   * same address for as long as the computer stays up, so it is kept briefly and dropped whenever
   * it may have changed: on stop, reset and update here, and on any call that found nothing
   * answering there (which is then asked again once, when the request never connected and so
   * cannot have done anything).
   *
   * Not for anything resolved against a run (an action citing a ref, a snapshot, a fill): there the
   * locate is also how the supervisor reports a replaced container, so those locate afresh.
   */
  const locateCacheMs = options.locateCacheMs ?? LOCATE_CACHE_MS;
  const located = new Map<string, { address: string; at: number }>();
  const forgetLocation = (botId: string) => {
    located.delete(botId);
  };

  /**
   * The policy for a Bot, kept for at most {@link POLICY_CACHE_MS} and never past a change.
   *
   * A changed policy is taken at once, never served stale: the policy store replaces its object on
   * every change (a save here, a reset, another server's change arriving through the listener), so
   * an object that is not the one kept is a change, and `invalidatePolicy` drops it outright. A
   * boundary an administrator has just tightened must not wait out a cache. What is kept is the
   * read itself, for a source that is not a free in-memory getter.
   */
  const policyCacheMs = options.policyCacheMs ?? POLICY_CACHE_MS;
  const policies = new Map<
    string,
    { policy: ActionPolicy | undefined; at: number }
  >();
  const policyFor = (botId: string): ActionPolicy | undefined => {
    const policy = options.policy();
    const held = policies.get(botId);
    if (held && held.policy === policy && Date.now() - held.at < policyCacheMs)
      return held.policy;
    if (policyCacheMs > 0) policies.set(botId, { policy, at: Date.now() });
    return policy;
  };

  /**
   * Where this Bot's computer is, checked before anything is sent to it.
   *
   * The provider decides the address, and a provider is a plug: it can be this deployment's own
   * supervisor on loopback or a backend somewhere else answering over its own API. Either way the
   * address goes straight into `fetch` carrying this deployment's computer token, so it is worth
   * confirming it is an address we speak to rather than whatever came back.
   *
   * Not the navigation check. That one refuses private hosts, which is the right answer for where a
   * Bot may browse and the wrong one here, where loopback is the normal case.
   */
  async function locateFresh(botId: string): Promise<string> {
    const address = await provider.locate(botId);
    const verdict = checkComputerAddress(address);
    if (!verdict.allowed) {
      forgetLocation(botId);
      throw new ComputerUnavailableError(verdict.reason);
    }
    if (locateCacheMs > 0)
      located.set(botId, { address: verdict.url, at: Date.now() });
    return verdict.url;
  }

  async function locate(botId: string): Promise<string> {
    const held = located.get(botId);
    if (held && Date.now() - held.at < locateCacheMs) return held.address;
    return locateFresh(botId);
  }

  /**
   * Send to the computer, and when a remembered address turns out to have nothing behind it, drop
   * it, locate again and resend once. Only when the request never connected: one that reached the
   * computer and then failed may have done something, and is not sent twice.
   */
  async function viaComputer<T>(
    botId: string,
    send: (address: string) => Promise<T>,
    address?: string,
  ): Promise<T> {
    const remembered = located.get(botId)?.address;
    const target = address ?? (await locate(botId));
    try {
      return await send(target);
    } catch (error) {
      if (
        error instanceof ComputerUnavailableError &&
        !(error instanceof ComputerStoppedError)
      ) {
        forgetLocation(botId);
        if (error.neverConnected && target === remembered)
          return send(await locateFresh(botId));
      }
      throw error;
    }
  }

  async function get<T>(
    botId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return viaComputer(botId, (address) =>
      transport.call<T>(address, botId, path, undefined, signal),
    );
  }

  /**
   * `address` is this action's own `/ensure`, when the caller has already made it.
   *
   * Locating twice for one action is two calls to the supervisor to learn the same thing, and worse,
   * they can disagree: the run the action was decided against would not be the run it was sent to.
   * Passing the address through means the check and the send are the same trip.
   */
  async function post<T>(
    botId: string,
    path: string,
    payload: unknown,
    signal?: AbortSignal,
    timeoutMs?: number,
    address?: string,
  ): Promise<T> {
    return viaComputer(
      botId,
      (target) =>
        transport.post<T>(target, botId, path, payload, signal, timeoutMs),
      address,
    );
  }

  /**
   * This action's own `/ensure`, or nothing when it cannot be made.
   *
   * A computer that cannot be located is not a verdict this may reach on its own. The action still
   * has to be decided and recorded, and the attempt failing is what writes the failure row beside the
   * decision; throwing here would take the action off the trail entirely. So a failure answers
   * "unknown", which leaves the generation check where it was and leaves the address to the attempt.
   */
  async function locateForAction(
    botId: string,
    fresh = false,
  ): Promise<string | undefined> {
    try {
      return fresh ? await locateFresh(botId) : await locate(botId);
    } catch {
      return undefined;
    }
  }

  /*
   * The transport's deadline for a command, which is a backstop and not the limit.
   *
   * The shell enforces the real one: 120s by default, 600s at most, and it answers with `timedOut`
   * so the person is told the command was stopped rather than that the computer went quiet. This
   * only has to outlast it. Below the shell's maximum, the transport gave up first and the person was
   * told the computer did not respond while the command ran on to completion inside the container.
   */
  const COMMAND_BACKSTOP_MS = 615_000;

  /*
   * A download has no command-like budget of its own. The computer refuses oversized files before
   * streaming, but a large permitted file can still outlive the ordinary request deadline on a slow
   * link. Five minutes is a backstop, not a size limit.
   */
  const DOWNLOAD_BACKSTOP_MS = 300_000;

  /**
   * Whether a Bot's browser is running, asked without starting anything.
   *
   * A computer that is not up has no browser running, and a computer that cannot be reached is not
   * known either way. A computer that is up is asked its `/health`, which reports the browser of the
   * Bot in the header and starts nothing; locating a computer that is already up is the same address
   * every action uses, and wakes nothing. Bounded, because this is for drawing a panel.
   */
  async function browserOf(
    botId: string,
    status: ComputerStatus,
  ): Promise<ComputerStatus["browser"]> {
    if (status.state === "absent" || status.state === "starting")
      return "stopped";
    if (status.state !== "ready") return undefined;
    try {
      const health = await transport.call<{ browser?: unknown } | null>(
        await locate(botId),
        botId,
        "/health",
        undefined,
        undefined,
        5_000,
      );
      return typeof health?.browser === "boolean"
        ? health.browser
          ? "running"
          : "stopped"
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Read-only, so it passes straight through. Nothing has changed and there is nothing to decide. */
  async function screenshot(botId: string): Promise<ScreenshotResult> {
    return get<ScreenshotResult>(botId, "/screenshot");
  }

  /** Read-only like the page screenshot, and of the screen rather than the page. */
  async function desktopScreenshot(
    botId: string,
    options?: { width?: number },
  ): Promise<ScreenshotResult> {
    const width =
      options?.width !== undefined && Number.isFinite(options.width)
        ? Math.round(options.width)
        : undefined;
    return get<ScreenshotResult>(
      botId,
      `/desktop/screenshot${width !== undefined ? `?width=${width}` : ""}`,
    );
  }

  /**
   * Read-only for the page, but it writes the resolution table the boundary reads.
   *
   * Nothing on the page changes and there is nothing to decide, so the snapshot itself passes
   * straight through. What it does record is the ref-to-element mapping every later action on this
   * computer is resolved against, and it records it where another replica can read it: the click that
   * uses these refs will almost certainly arrive on a different process. The write is awaited before
   * the refs are returned, so the snapshot cannot be resolved against on one server before it exists
   * on the store.
   */
  async function snapshot(botId: string): Promise<SnapshotResult> {
    /*
     * Located afresh, not from the cache: the run asked below is the one the last locate reported
     * on the supervisor, and a snapshot stored under a run that has since been replaced would be
     * refused at the next click, and the snapshot after it, for as long as the cache held.
     */
    const base = await locateFresh(botId);
    /*
     * Which run this is, asked before the page is drawn rather than after it.
     *
     * After `locate`, because on a supervisor that is the `/ensure` that reports it. But before
     * `/snapshot`, because the two answers have to describe the same browser and asking afterwards
     * does not guarantee it: a computer replaced while the snapshot was being taken would have its
     * dead page stamped with the run of the browser that replaced it, so every ref on that page would
     * resolve against the live run and the live run's own snapshots would be refused for being older.
     *
     * Asked first, a replacement in that window leaves a row carrying a run that is already gone.
     * Nothing resolves against it and the next snapshot supersedes it, which is the direction this is
     * allowed to fail in.
     */
    const run = await sessionOf(botId);
    const result = await viaComputer(
      botId,
      (address) =>
        transport.call<SnapshotResult>(address, botId, "/snapshot", {
          method: "POST",
        }),
      base,
    );
    // Durable before the refs are handed out: the click that uses them may land on another replica.
    await snapshots.saveNow(botId, {
      snapshotId: result.snapshotId,
      url: result.url,
      elements: new Map(
        result.elements.map((element) => [element.ref, element]),
      ),
      ...run,
    });
    // Element names and values are whatever the page says they are, so they are marked too.
    return withUntrustedNotice(result, "web page", SNAPSHOT_FIELDS);
  }

  /**
   * Which run of the computer this is, shaped to spread into a snapshot.
   *
   * Absent for a provider that cannot say, and absent if asking fails: a session that cannot be read
   * must not stop a snapshot being recorded, because a snapshot nobody stored is a ref that resolves
   * to nothing and a boundary deciding with no element in front of it.
   */
  async function sessionOf(botId: string): Promise<{ session?: string }> {
    if (!provider.sessionOf) return {};
    try {
      const session = await provider.sessionOf(botId);
      return session ? { session } : {};
    } catch {
      return {};
    }
  }

  async function read(
    botId: string,
    options: { waitFor?: string; timeoutMs?: number } = {},
  ): Promise<ReadResult> {
    const query = new URLSearchParams();
    const waitFor = options.waitFor?.trim().slice(0, 200);
    if (waitFor) query.set("waitFor", waitFor);
    if (waitFor && options.timeoutMs !== undefined)
      query.set("timeoutMs", String(Math.min(20_000, options.timeoutMs)));
    // Page text is outside content: marked here, once, so the headless tools and the browser's
    // routes hand the model the same envelope. See untrusted-content.ts.
    return withUntrustedNotice(
      await get<ReadResult>(botId, query.size ? `/read?${query}` : "/read"),
      "web page",
      PAGE_FIELDS,
    );
  }

  /**
   * Resolve a ref against the snapshot the server holds, and only against the one it came from.
   *
   * Returns undefined for an unknown ref rather than throwing, because the policy still has to run:
   * an action on an element we cannot identify must still receive a policy decision, and a deny rule
   * written against a page a Bot has not snapshotted should still refuse it.
   *
   * A ref resolves only when its generation matches the stored snapshot's. A ref carrying a
   * superseded generation resolves to nothing rather than to whatever now holds that ref: the policy
   * must never decide on an element the caller has already scrolled off the page. The computer makes
   * the same generation check when the action reaches it; this one keeps the decision and the audit
   * row honest before it gets there, on whichever replica the action landed.
   */
  function resolve(
    stored: StoredSnapshot | undefined,
    ref: string | undefined,
    snapshotId: number | undefined,
    /**
     * The run of the computer the action is reaching, when the provider can say.
     *
     * Undefined means unknown, not mismatched: a provider that could not be asked leaves the
     * generation check exactly as it was, rather than refusing every ref it holds.
     */
    session?: string,
  ): SnapshotElement | undefined {
    if (!ref || !stored || stored.snapshotId !== snapshotId) return undefined;
    /*
     * A generation is only unique within one run of the computer.
     *
     * A replaced container counts from one again, so a ref the model is still holding from the run
     * before matches a row nothing has overwritten, and the element handed to the policy belongs to
     * a page that no longer exists. `resetComputer` clears the row for that reason and is the only
     * thing that does; the supervisor replacing a computer whose image changed does not, and the
     * server is never told. Comparing the run closes both.
     */
    if (session && stored.session && stored.session !== session) {
      return undefined;
    }
    return stored.elements.get(ref);
  }

  /**
   * Decide, record, then act.
   *
   * The audit row is written before the action runs, not after it succeeds. An allowed action that
   * later fails is still part of the audit sequence, and a trail that only contains successes cannot
   * show that sequence.
   */
  /**
   * A challenge the page showed after an action (a CAPTCHA, a Cloudflare check) opens a takeover
   * inside the computer itself, not through `requestHelp`, so the listener never heard the Bot need
   * the person. Told now as a help request, with the computer's own state read back so the request
   * and its source are the computer's. Never awaited and never in the action's way.
   */
  function announceChallenge(
    botId: string,
    actor: ActionActor,
    result: unknown,
  ) {
    const listener = options.onControlEvent;
    if (!listener || !result || typeof result !== "object") return;
    const challenge = (result as { challenge?: { reason?: string } }).challenge;
    if (!challenge) return;
    void get<ControlState>(botId, "/control")
      .then((state) =>
        notifyControl(listener, {
          type: "help_requested",
          botId,
          actor,
          ...(challenge.reason ? { reason: challenge.reason } : {}),
          state,
        }),
      )
      .catch(() => undefined);
  }

  async function govern<T>(
    toolName: string,
    botId: string,
    actor: ActionActor,
    subject: {
      ref?: string;
      /** The generation the ref came from. A ref only resolves against its own snapshot. */
      snapshotId?: number;
      filePath?: string;
      targetUrl?: string;
      key?: string;
      /** The command a shell call is about to run, so a rule can be written against it. */
      command?: string;
      /** The person's Stop, on its way to the browser. See the acting methods below. */
      signal?: AbortSignal;
      /**
       * The action answers with the page it produced, whose snapshot is stored for the next refs,
       * so it needs this computer's run even without a ref of its own.
       */
      page?: boolean;
    },
    run: (address: string | undefined, context: GovernedRun) => Promise<T>,
  ): Promise<T> {
    const { ref, filePath, snapshotId } = subject;
    /*
     * LOCATE FIRST, THEN ASK WHICH RUN THAT WAS. The order is the check.
     *
     * On the supervisor, `sessionOf` answers with what the last `/ensure` reported, and until this
     * action has made its own, the last one belongs to the action before it. Asking first compared
     * the stored snapshot against the previous action's run, which is the same run on every action
     * but the first one after a replacement — exactly the action the check exists to catch. The
     * shared provider has no `/ensure` to read back, so there it is a live `/run` call of its own,
     * which asks after `locate` for the same reason even though `locate` there is a string.
     *
     * The snapshot is loaded beside that, from the store rather than this process's memory: the
     * snapshot these refs belong to was very likely taken by another replica. The two reads do not
     * depend on each other, so neither waits for the other.
     *
     * Only for a browser action. A file read or a shell call is not resolved against a page, and
     * should not have to reach the supervisor before the policy has even seen it.
     */
    const browser = Boolean(ref) || subject.page === true;
    const [stored, address] = await Promise.all([
      snapshots.load(botId, ref ? snapshotId : undefined),
      /*
       * Afresh for a ref, from the cache otherwise. A ref is resolved against the run, and on the
       * supervisor the run is what this locate's `/ensure` reports: a remembered address would
       * compare the stored snapshot against the run before a replacement, and the first click after
       * the container was replaced would go through. Everything else only needs the address.
       */
      browser
        ? locateForAction(botId, Boolean(ref))
        : Promise.resolve(undefined),
    ]);
    const asked = browser
      ? sessionOf(botId)
      : Promise.resolve<{ session?: string }>({});
    const { session } = ref ? await asked : { session: undefined };
    const element = resolve(stored, ref, snapshotId, session);
    // For a navigation the relevant page is the one being opened, not the one already loaded. Using
    // the stored URL would mean `page.host == "..."` could never match the destination, which is the
    // only thing a rule about navigation would ever want to say.
    const pageUrl = subject.targetUrl ?? stored?.url ?? "";

    const intent = intentFor(toolName, subject.key, element);
    const decision = evaluateActionPolicy(
      policyFor(botId),
      policyContext({
        toolName,
        botId,
        actor,
        pageUrl,
        intent,
        element,
        key: subject.key,
        filePath,
        command: subject.command,
      }),
    );
    const decisionRow = write(auditStore, {
      toolName,
      botId,
      actor,
      element,
      ref,
      ...(subject.key ? { key: subject.key } : {}),
      ...(subject.command ? { command: subject.command } : {}),
      filePath,
      pageUrl,
      decision,
    });
    /*
     * A citation that was made and could not be honoured is refused, not carried out.
     *
     * `resolve` answering undefined leaves the element half of the context all-empty, and empty is
     * the honest neutral value for an action that names no element: it is what stops a rule about
     * one action surface throwing on another. It is the wrong answer for an action that named a ref
     * and did not get one. Every element-keyed rule then evaluates against empty strings, so a deny
     * that exists to stop this exact click does not match, the shipped default permits, and the
     * click lands on whatever that ref is now. The rule did not decline to match. It was never
     * shown the element.
     *
     * The computer's own staleness check does not make this safe. It compares the citation against
     * its own counter, so it catches the cases where the two disagree; the case that matters is the
     * one where the computer is content and only this server is out of step, which is what a
     * computer restarting its generation counter under a stored row leaves behind.
     *
     * Only a cited ref, and only against a snapshot this server actually holds. A computer this
     * server has no snapshot for at all is a different situation: there is no page here to judge
     * the citation against, the computer is the only party that can, and refusing locally would
     * take its answer away, including the one that says a person has taken the wheel.
     *
     * Thrown from inside the attempt, after the decision row, on purpose: an action whose ref
     * resolves to nothing is still an action somebody tried to take, and refusing it before the row
     * was written would be a way to act without appearing on the trail.
     */
    const stale = Boolean(ref && stored && !element);
    /*
     * The approval gate's reads go out beside the decision row's write. Both are awaited before
     * anything is sent to the computer, so nothing acts without its row; they only stop queueing
     * behind each other. Its failure is observed below, after the row has landed.
     */
    const continuation = currentApprovalContext();
    const gating: Promise<ApprovalPermit | undefined> | undefined =
      decision.forward && !stale
        ? options.approvalGate?.({
            actorId: actor.id,
            botId,
            toolRef: toolName,
            effect: ["activate", "type", "write_file", "run_command"].includes(
              intent ?? "",
            )
              ? "write"
              : "read",
            scope: filePath
              ? filePath.split("/").slice(0, -1).join("/") || "workspace"
              : subject.command
                ? "workspace"
                : hostOf(pageUrl) || "browser",
            args: continuation?.args ?? {
              ...subject,
              signal: undefined,
              page: undefined,
            },
            target: {
              pageUrl,
              ...(element ? { element, snapshotId } : {}),
              ...(filePath ? { filePath } : {}),
            },
            continuation,
          })
        : undefined;
    gating?.catch(() => undefined);
    await decisionRow;
    if (!decision.forward) {
      throw new ActionRefusedError(decision.reason, decision.matched);
    }

    let result: T;
    try {
      if (stale) {
        throw new StaleSnapshotError(
          `${ref} is not on the page this computer is showing, so nothing can be checked against it before acting. Take a fresh snapshot and use the refs it returns.`,
        );
      }
      const approval = await gating;
      result =
        approval && "replay" in approval
          ? (approval.replay as T)
          : await run(address, {
              session: async () => (await asked).session,
            });
      await approval?.complete(result);
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) throw error;
      if (
        error instanceof ComputerUnavailableError &&
        !(error instanceof ComputerStoppedError)
      )
        forgetLocation(botId);
      /**
       * A permitted action that did not happen gets its own row.
       *
       * Without this the trail lies by omission. The row above says the policy allowed the call, and
       * a reader takes "allowed" to mean "it happened".
       *
       * It carries the same subject the decision row did, and for the same reasons: a shell call
       * that failed part-way is the row somebody most needs to name the command from, and a keypress
       * that failed is still the difference between a submitted form and a typed letter.
       */
      await write(auditStore, {
        toolName,
        botId,
        actor,
        element,
        ref,
        ...(subject.key ? { key: subject.key } : {}),
        ...(subject.command ? { command: subject.command } : {}),
        filePath,
        pageUrl,
        decision,
        failure: error instanceof Error ? error.message : "The action failed.",
        // A person pressing Stop mid-action is not the computer failing. The message still says so;
        // this keeps the row's type a stop, so a count of failed actions does not read every Stop as
        // an outage.
        ...(error instanceof ComputerStoppedError ? { stopped: true } : {}),
      });
      throw error;
    }
    announceChallenge(botId, actor, result);
    // The element's label, attached on the way out, so the transcript can say what was acted on
    // instead of quoting a ref. The computer cannot supply this: it knows the ref, and the resolved
    // snapshot lives here. File calls carry their own path already, so there is nothing to add.
    return element && result && typeof result === "object"
      ? { ...result, element: { role: element.role, name: element.name } }
      : result;
  }

  /**
   * Store the snapshot of the page an action produced, so the refs in its lines resolve for the
   * next action on any replica, and take the full list off before the model sees the result.
   *
   * Written through (snapshot-store.ts): the row follows in the background, in order.
   */
  async function keepPage<T>(
    botId: string,
    result: T,
    context: GovernedRun,
  ): Promise<T> {
    if (!result || typeof result !== "object" || !("page" in result))
      return result;
    const page = (result as { page?: unknown }).page as
      | (PageReport & {
          snapshot?: { elements?: SnapshotElement[]; truncated?: boolean };
        })
      | undefined;
    if (!page || typeof page !== "object") return result;
    const { snapshot, ...shown } = page;
    if (
      snapshot &&
      Array.isArray(snapshot.elements) &&
      typeof page.snapshotId === "number"
    ) {
      const session = await context.session();
      await snapshots.save(botId, {
        snapshotId: page.snapshotId,
        url: page.url,
        elements: new Map(
          snapshot.elements.map((element) => [element.ref, element]),
        ),
        ...(session ? { session } : {}),
      });
    }
    return { ...result, page: shown };
  }

  /** One acting call that answers with a page: governed, sent, its page kept and marked. */
  function pageAction<R>(
    toolName: string,
    path: string,
    botId: string,
    actor: ActionActor,
    subject: Parameters<typeof govern>[3],
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<R> {
    return govern(
      toolName,
      botId,
      actor,
      { ...subject, page: true, ...(signal ? { signal } : {}) },
      async (address, context) =>
        keepPage(
          botId,
          await post<R>(botId, path, payload, signal, undefined, address),
          context,
        ),
    ).then((result) => markPage(result));
  }

  /**
   * A whole page of fields in one call, each decided and recorded as its own tool would be.
   *
   * A text field is decided as `computer_type`, a drop-down as `computer_select`, a box as
   * `computer_check`, a file as `computer_upload` (with its path), and `then` as the click or the
   * Enter it is. So a rule about typing into a field, ticking "I agree" or sending a file applies
   * inside a fill exactly as outside one, and the trail has a row per field, written before
   * anything is sent. The first refused field stops the batch: the fields before it are sent, it
   * and everything after are not, and the result says which field and why.
   *
   * One request to the computer for all of it, and one question to the approval gate for the
   * whole fill: a person asked to approve a form approves the form, not each box on it.
   */
  async function fill(
    botId: string,
    actor: ActionActor,
    input: FillInput,
    signal?: AbortSignal,
  ): Promise<FillResult> {
    const [stored, address] = await Promise.all([
      snapshots.load(botId, input.snapshotId),
      // Afresh, for the run its refs are resolved against. See `govern`.
      locateForAction(botId, true),
    ]);
    const asked = sessionOf(botId);
    const { session } = await asked;
    const pageUrl = stored?.url ?? "";
    const policy = policyFor(botId);

    type Step = {
      index: number | "then";
      ref: string;
      toolName: string;
      key?: string;
      filePath?: string;
    };
    const fields: Step[] = input.fields.map((field, index) => ({
      index,
      ref: field.ref,
      ...(field.file !== undefined
        ? { toolName: "computer_upload", filePath: field.file }
        : field.option !== undefined
          ? { toolName: "computer_select" }
          : field.checked !== undefined
            ? { toolName: "computer_check" }
            : { toolName: "computer_type" }),
    }));
    const last = input.fields.at(-1)?.ref;
    const after: Step | undefined = !input.then
      ? undefined
      : "click" in input.then
        ? { index: "then", ref: input.then.click, toolName: "computer_click" }
        : last
          ? { index: "then", ref: last, toolName: "computer_key", key: "Enter" }
          : undefined;

    // Decided and recorded in order, each row written before the next is decided.
    const decided: Array<{
      step: Step;
      element: SnapshotElement | undefined;
      decision: PolicyDecision;
    }> = [];
    for (const step of after ? [...fields, after] : fields) {
      const element = resolve(stored, step.ref, input.snapshotId, session);
      const decision = evaluateActionPolicy(
        policy,
        policyContext({
          toolName: step.toolName,
          botId,
          actor,
          pageUrl,
          intent: intentFor(step.toolName, step.key, element),
          element,
          key: step.key,
          filePath: step.filePath,
          command: undefined,
        }),
      );
      await write(auditStore, {
        toolName: step.toolName,
        botId,
        actor,
        element,
        ref: step.ref,
        ...(step.key ? { key: step.key } : {}),
        filePath: step.filePath,
        pageUrl,
        decision,
      });
      decided.push({ step, element, decision });
      if (!decision.forward) break;
    }
    const refusal = decided.find((entry) => !entry.decision.forward);
    const allowed = decided.filter((entry) => entry.decision.forward);
    const fieldsSent = allowed.filter(
      (entry) => entry.step.index !== "then",
    ).length;
    const thenSent = allowed.some((entry) => entry.step.index === "then");
    const label = (entry: (typeof decided)[number]) =>
      entry.element ? `"${entry.element.name}"` : entry.step.ref;
    if (refusal && allowed.length === 0)
      throw new ActionRefusedError(
        `${refusal.step.index === "then" ? "The final step" : `Field ${refusal.step.index}`} (${label(refusal)}) was refused, so nothing was filled in: ${refusal.decision.reason}`,
        refusal.decision.matched,
      );

    /** A permitted step that did not happen, recorded as such. See `govern`. */
    const failed = async (
      entries: typeof decided,
      failure: string,
      stopped = false,
    ) => {
      for (const entry of entries)
        await write(auditStore, {
          toolName: entry.step.toolName,
          botId,
          actor,
          element: entry.element,
          ref: entry.step.ref,
          ...(entry.step.key ? { key: entry.step.key } : {}),
          filePath: entry.step.filePath,
          pageUrl,
          decision: entry.decision,
          failure,
          ...(stopped ? { stopped: true } : {}),
        });
    };

    let raw: FillResult;
    try {
      // The same refusal `govern` makes for a ref the stored page does not have. See there.
      const unresolved = stored
        ? allowed.find((entry) => !entry.element)
        : undefined;
      if (unresolved)
        throw new StaleSnapshotError(
          `${unresolved.step.ref} is not on the page this computer is showing, so nothing can be checked against it before acting. Take a fresh snapshot and use the refs it returns.`,
        );
      const continuation = currentApprovalContext();
      const approval = await options.approvalGate?.({
        actorId: actor.id,
        botId,
        toolRef: "computer_fill",
        effect: "write",
        scope: hostOf(pageUrl) || "browser",
        args: continuation?.args ?? { ...input },
        target: {
          pageUrl,
          snapshotId: input.snapshotId,
          elements: allowed.flatMap((entry) =>
            entry.element ? [entry.element] : [],
          ),
        },
        continuation,
      });
      const payload = {
        snapshotId: input.snapshotId,
        fields: input.fields.slice(0, fieldsSent),
        // biome-ignore lint/suspicious/noThenProperty: `then` is the tool contract's field name.
        ...(thenSent && input.then ? { then: input.then } : {}),
      };
      raw =
        approval && "replay" in approval
          ? (approval.replay as FillResult)
          : await keepPage(
              botId,
              await post<FillResult>(
                botId,
                "/fill",
                payload,
                signal,
                FILL_BACKSTOP_MS,
                address,
              ),
              { session: async () => (await asked).session },
            );
      await approval?.complete(raw);
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) throw error;
      if (
        error instanceof ComputerUnavailableError &&
        !(error instanceof ComputerStoppedError)
      )
        forgetLocation(botId);
      await failed(
        allowed,
        error instanceof Error ? error.message : "The fill failed.",
        error instanceof ComputerStoppedError,
      );
      throw error;
    }

    // The field the computer could not fill, and every step after it, did not happen.
    if (raw.failed) {
      const at = raw.failed.index;
      const from = allowed.findIndex((entry) => entry.step.index === at);
      if (from >= 0)
        await failed(
          allowed.slice(from),
          `${raw.failed.error}${from + 1 < allowed.length ? " (later fields were not attempted)" : ""}`,
        );
    }
    const labelled = (raw.filled ?? []).map((field) => {
      const element = decided[field.index]?.element;
      return element
        ? { ...field, element: { role: element.role, name: element.name } }
        : field;
    });
    return markPage({
      ...raw,
      filled: labelled,
      ...(refusal
        ? {
            refused: {
              index: refusal.step.index,
              ref: refusal.step.ref,
              ...(refusal.element
                ? {
                    element: {
                      role: refusal.element.role,
                      name: refusal.element.name,
                    },
                  }
                : {}),
              reason: `${refusal.step.index === "then" ? "The final step" : `Field ${refusal.step.index}`} (${label(refusal)}) was refused and nothing from it on was done: ${refusal.decision.reason}`,
              rule: refusal.decision.matched,
            },
          }
        : {}),
    });
  }

  return {
    provider,
    ...(pageFrames ? { pageFrames } : {}),
    locate,
    screenshot,
    desktopScreenshot,
    snapshot,
    read,

    /*
     * Clicky's reads. Passed straight through like a screenshot: nothing changes and there is
     * nothing to decide. Not marked untrusted here because no model reads these results as they
     * are; Clicky's brain wraps every name in the envelope before its model sees one.
     */
    elements(botId: string) {
      return get<ScreenElements>(botId, "/elements");
    },
    elementAt(
      botId: string,
      point: { x: number; y: number },
      options?: { verifyWindow?: boolean },
    ) {
      return post<ElementAtResult>(botId, "/elements/at", {
        ...point,
        ...(options?.verifyWindow ? { verifyWindow: true } : {}),
      });
    },
    focus(botId: string) {
      return get<FocusResult>(botId, "/elements/focus");
    },
    clickyFrame(botId: string, width: number) {
      return get<ClickyFrame>(
        botId,
        `/elements/frame?width=${Math.round(width)}`,
      );
    },
    actionPolicy(botId: string) {
      return policyFor(botId);
    },

    async status(
      botId: string,
      options?: { browser?: boolean },
    ): Promise<ComputerStatus> {
      const status = await provider.status(botId);
      if (!options?.browser || status.browser) return status;
      const browser = await browserOf(botId, status);
      return browser ? { ...status, browser } : status;
    },

    /**
     * Handovers, recorded but not policy-gated.
     *
     * The policy constrains what a Bot may do. A person taking the wheel is the escape hatch that
     * makes a governed Bot usable at all, and a rule able to lock somebody out of their own browser
     * halfway through a login would be a worse failure than anything it prevented. So these write the
     * row and do not ask. What IS recorded is the period: who, when, and why the Bot asked, the fact
     * an investigator wants is that a human drove this browser between two times.
     */
    async requestHelp(
      botId: string,
      actor: ActionActor,
      reason: string,
      toolCallId?: string,
      requestOptions?: { pointAt?: string },
    ) {
      const state = await post<ControlState>(botId, "/control/request", {
        reason,
        ...(toolCallId ? { toolCallId } : {}),
      });
      await writeControlEvent(auditStore, "computer.help_requested", {
        botId,
        actor,
        reason,
      });
      notifyControl(options.onControlEvent, {
        type: "help_requested",
        botId,
        actor,
        reason,
        toolCallId,
        ...(requestOptions?.pointAt ? { pointAt: requestOptions.pointAt } : {}),
        state,
      });
      return state;
    },

    async takeControl(botId: string, actor: ActionActor, requestId: string) {
      const state = await post<ControlState>(botId, "/control/take", {
        requestId,
      });
      await writeControlEvent(auditStore, "computer.control_taken", {
        botId,
        actor,
        // Carried onto the row so the trail says what the person was handed, not merely that they
        // took over.
        reason: state.reason,
      });
      notifyControl(options.onControlEvent, {
        type: "control_taken",
        botId,
        actor,
        state,
      });
      return state;
    },

    async releaseControl(botId: string, actor: ActionActor, requestId: string) {
      const state = await post<ControlState>(botId, "/control/release", {
        requestId,
      });
      await writeControlEvent(auditStore, "computer.control_released", {
        botId,
        actor,
      });
      notifyControl(options.onControlEvent, {
        type: "control_released",
        botId,
        actor,
        state,
      });
      return state;
    },

    async cancelControl(botId: string, actor: ActionActor, requestId: string) {
      const state = await post<ControlState>(botId, "/control/cancel", {
        requestId,
      });
      await writeControlEvent(auditStore, "computer.help_cancelled", {
        botId,
        actor,
      });
      notifyControl(options.onControlEvent, {
        type: "help_cancelled",
        botId,
        actor,
        state,
      });
      return state;
    },

    control(botId: string, requestId?: string): Promise<ControlState> {
      return get<ControlState>(
        botId,
        `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
      );
    },

    /** Return every computer that the configured provider owns. */
    async computers() {
      const computers = await provider.list();
      return {
        isolation: provider.isolation,
        computers: computers.map((computer) => ({
          botId: computer.botId,
          running: computer.status === "running",
          startedAt: computer.startedAt ?? null,
          egress: computer.egress,
          ...(computer.updateAvailable !== undefined
            ? { updateAvailable: computer.updateAvailable }
            : {}),
        })),
      };
    },

    /**
     * Stop a computer's browser, keeping what it knows.
     *
     * Audited, unlike the read above, because a person reached in and stopped something. Recorded
     * whether or not a browser was actually running: "she pressed stop and nothing was running" is a
     * fact worth having, and a trail that only records effective actions cannot tell you what somebody
     * tried.
     */
    async stopComputer(botId: string, actor: ActionActor) {
      forgetLocation(botId);
      const result = await provider.stop(botId);
      await writeControlEvent(auditStore, "computer.stopped", {
        botId,
        actor,
        reason: result.wasRunning
          ? "the computer was stopped"
          : "the computer was already stopped",
      });
      return result;
    },

    /**
     * Wipe a computer's profile.
     *
     * The most destructive button we have. Every login the Bot had is gone and no undo exists, so the
     * row is written whatever happens next.
     */
    /**
     * Move a computer onto the image this deployment now runs.
     *
     * Only a provider that can say a computer is out of date offers it. The row is written for a
     * computer that was already current too, so the trail shows the button was pressed.
     */
    async updateComputer(botId: string, actor: ActionActor) {
      if (!provider.update) {
        throw new ComputerUnavailableError(
          `The ${provider.name} computer provider has no computer image of its own to update.`,
        );
      }
      forgetLocation(botId);
      const result = await provider.update(botId);
      await writeControlEvent(auditStore, "computer.updated", {
        botId,
        actor,
        reason: !result.updated
          ? "the computer was already on the current image, or had none"
          : result.wasRunning
            ? `the computer is restarting on ${result.to}, keeping its files and sign-ins`
            : `the computer will start on ${result.to} when it is next used`,
      });
      return result;
    },

    async resetComputer(botId: string, actor: ActionActor) {
      forgetLocation(botId);
      const result = await provider.reset(botId);
      /*
       * The row goes in HERE, before the two deletes below, because this line is the point of no
       * return: the profile is already gone and nothing after it can put the logins back.
       *
       * Both clears are Postgres deletes, and a connection reset, a failover or a statement timeout
       * in either used to throw before the row was written -- leaving a computer wiped with nothing
       * on the trail to say who wiped it, which is the one outcome the note above rules out. The
       * failure still propagates, so the caller is told the clears did not finish.
       */
      await writeControlEvent(auditStore, "computer.reset", {
        botId,
        actor,
        reason: result.cleared
          ? "the computer and its saved state were deleted"
          : "no saved state was present to delete",
      });
      // The refs the last snapshot handed out describe a page that no longer exists, and a fresh
      // computer counts generations from one again, so the row has to go with the profile.
      await snapshots.clear(botId);
      /*
       * And the pictures, which are the part that made the promise above untrue.
       *
       * "Every login the Bot had is gone" was said while screenshots of the signed-in pages stayed
       * in the database: an inbox, an admin console, a bank statement, still readable from the
       * transcript by anybody who could reach that Bot. A reset that leaves those has not reset
       * anything a person would recognise as private.
       */
      await pageFrames?.clear(botId);
      return result;
    },

    /**
     * Asking for a secret, and supplying one.
     *
     * Both are audited, and neither records the value. The row says a secret was asked for, what it
     * was called, and which field it went in, the things an investigator needs in order to know a
     * human credential entered this session. The value itself is on one path only, from a person's
     * keyboard to the page, and is not on this one.
     */
    async requestSecret(
      botId: string,
      actor: ActionActor,
      input: SecretRequest,
    ) {
      const state = await post<ControlState>(botId, "/control/secret", input);
      await writeControlEvent(auditStore, "computer.secret_requested", {
        botId,
        actor,
        reason: `${input.label} (into ${input.ref})`,
      });
      notifyControl(options.onControlEvent, {
        type: "secret_requested",
        botId,
        actor,
        reason: input.label,
        state,
      });
      return state;
    },

    /**
     * Typing a person's login into the Bot's browser, from the private sign-in form.
     *
     * The credential arrives from the passwords module and goes straight to the computer. It is not
     * audited here, not returned, and not logged; the passwords module writes the row, without it.
     */
    async cancelSecret(botId: string, actor: ActionActor) {
      const state = await post<ControlState>(botId, "/human/secret/cancel", {});
      await writeControlEvent(auditStore, "computer.secret_cancelled", {
        botId,
        actor,
        reason: "The person declined to enter it.",
      });
      notifyControl(options.onControlEvent, {
        type: "secret_cancelled",
        botId,
        actor,
        state,
      });
      return state;
    },

    probeSignIn(botId: string, signal?: AbortSignal) {
      return post<SignInProbe>(botId, "/sign-in/probe", {}, signal, 20_000);
    },

    signIn(botId: string, input: SignInFillInput, signal?: AbortSignal) {
      return post<SignInFillResult>(
        botId,
        "/sign-in/fill",
        input,
        signal,
        SIGN_IN_BACKSTOP_MS,
      );
    },

    async supplySecret(botId: string, actor: ActionActor, text: string) {
      const result = await post<SecretResult>(botId, "/human/secret", { text });
      await writeControlEvent(auditStore, "computer.secret_supplied", {
        botId,
        actor,
        // Length, never content. Enough to show something real was entered.
        reason: `${result.characters} characters`,
      });
      if (options.onControlEvent)
        void get<ControlState>(botId, "/control")
          .then((state) =>
            notifyControl(options.onControlEvent, {
              type: "secret_supplied",
              botId,
              actor,
              state,
            }),
          )
          .catch(() => undefined);
      return result;
    },

    async humanInput(
      botId: string,
      input: HumanInput,
    ): Promise<HumanInputResult> {
      const { kind, ...payload } = input;
      /*
       * Checked here as well as at the route, because this is where it becomes a path.
       *
       * `kind` is typed as one of four gestures and a type is not a check: the route casts a parsed
       * body to this shape, so whatever arrived is whatever the caller sent. Interpolated into the
       * path below, a value like `../exec` reaches a different endpoint of the computer's API
       * altogether, carrying this deployment's computer token. This method is also the one acting
       * path that writes no audit row, deliberately, so a call that went somewhere else leaves
       * nothing behind that would say so.
       */
      if (!HUMAN_GESTURES.has(kind)) {
        throw new Error(
          `A person's input is one of ${[...HUMAN_GESTURES].join(", ")}, not ${JSON.stringify(kind)}.`,
        );
      }
      return post<HumanInputResult>(botId, `/human/${kind}`, payload);
    },

    /**
     * Opening a page, through the gateway so it lands in the audit trail.
     *
     * The transport applies its target guard before it sends a request. This is
     * the minimum rule that applies even when the action policy permits the URL.
     */
    navigate(
      botId: string,
      actor: ActionActor,
      url: string,
      toolCallId?: string,
    ) {
      return govern(
        "computer_navigate",
        botId,
        actor,
        { targetUrl: url, page: true },
        async (address, context) =>
          keepPage(
            botId,
            await viaComputer(
              botId,
              (target) => transport.navigate(target, botId, url, toolCallId),
              address,
            ),
            context,
          ),
      ).then((result) =>
        withUntrustedNotice(result, "web page", [
          ...PAGE_FIELDS,
          ...(result.page ? (["page"] as const) : []),
        ]),
      );
    },

    click(
      botId: string,
      actor: ActionActor,
      input: ClickInput,
      signal?: AbortSignal,
    ) {
      return pageAction<ActionResult>(
        "computer_click",
        "/click",
        botId,
        actor,
        { ref: input.ref, snapshotId: input.snapshotId },
        input,
        signal,
      );
    },

    type(
      botId: string,
      actor: ActionActor,
      input: TypeInput,
      signal?: AbortSignal,
    ) {
      return pageAction<ActionResult>(
        "computer_type",
        "/type",
        botId,
        actor,
        {
          ref: input.ref,
          snapshotId: input.snapshotId,
          /*
           * `submit` presses Enter once the text is in, so this call is a keypress as well as a
           * typing one and the policy has to see both halves. Without the key here, an agent refused
           * on clicking the button and refused on pressing Enter types into the field with
           * `submit: true` instead, and the form goes through against a rule written to stop exactly
           * that. It is what the trail is missing too: a row with no key says a field was filled in,
           * not that the form was sent.
           */
          ...(input.submit ? { key: "Enter" } : {}),
        },
        input,
        signal,
      );
    },

    key(
      botId: string,
      actor: ActionActor,
      input: KeyInput,
      signal?: AbortSignal,
    ) {
      // The key is part of the subject, so a rule can tell Enter from a letter. Form submission can
      // happen through a keypress as well as a click, so the policy context carries the key.
      return pageAction<ActionResult>(
        "computer_key",
        "/key",
        botId,
        actor,
        { ref: input.ref, snapshotId: input.snapshotId, key: input.key },
        input,
        signal,
      );
    },

    scroll(
      botId: string,
      actor: ActionActor,
      input: ScrollInput,
      signal?: AbortSignal,
    ) {
      return pageAction<ActionResult>(
        "computer_scroll",
        "/scroll",
        botId,
        actor,
        input.ref ? { ref: input.ref, snapshotId: input.snapshotId } : {},
        input,
        signal,
      );
    },

    select(
      botId: string,
      actor: ActionActor,
      input: SelectInput,
      signal?: AbortSignal,
    ) {
      return pageAction<ActionResult>(
        "computer_select",
        "/select",
        botId,
        actor,
        { ref: input.ref, snapshotId: input.snapshotId },
        input,
        signal,
      );
    },

    check(
      botId: string,
      actor: ActionActor,
      input: CheckInput,
      signal?: AbortSignal,
    ) {
      return pageAction<ActionResult>(
        "computer_check",
        "/check",
        botId,
        actor,
        { ref: input.ref, snapshotId: input.snapshotId },
        input,
        signal,
      );
    },

    /**
     * A workspace file sent to a website. Governed with the file's path as well as the element, so a
     * rule about which files may leave the workspace (`file.path`, `file.extension`) applies to an
     * upload as it does to a download.
     */
    upload(
      botId: string,
      actor: ActionActor,
      input: UploadInput,
      signal?: AbortSignal,
    ) {
      return pageAction<ActionResult>(
        "computer_upload",
        "/upload",
        botId,
        actor,
        { ref: input.ref, snapshotId: input.snapshotId, filePath: input.path },
        input,
        signal,
      );
    },

    hover(
      botId: string,
      actor: ActionActor,
      input: HoverInput,
      signal?: AbortSignal,
    ) {
      return pageAction<ActionResult>(
        "computer_hover",
        "/hover",
        botId,
        actor,
        { ref: input.ref, snapshotId: input.snapshotId },
        input,
        signal,
      );
    },

    dialog(
      botId: string,
      actor: ActionActor,
      input: DialogInput,
      signal?: AbortSignal,
    ) {
      return pageAction<ActionResult>(
        "computer_dialog",
        "/dialog",
        botId,
        actor,
        // Accepting is pressing the dialog's OK; the trail says which it was.
        { key: input.accept ? "Enter" : "Escape" },
        input,
        signal,
      );
    },

    tabs(
      botId: string,
      actor: ActionActor,
      input: TabsInput,
      signal?: AbortSignal,
    ) {
      return pageAction<ActionResult>(
        "computer_tabs",
        "/tabs",
        botId,
        actor,
        {},
        input,
        signal,
      );
    },

    /**
     * Going back is a navigation, decided on where it goes: the tab's previous page, read from the
     * computer first, with the same target guard and the same `page.*` rules a navigation to it
     * would meet. The computer refuses to go if its history has moved on since (`expectedUrl`).
     * A computer that cannot say where back leads is decided on the page it is leaving, as before.
     */
    async back(botId: string, actor: ActionActor, signal?: AbortSignal) {
      const history = await get<{ back?: { url?: unknown } }>(
        botId,
        "/history",
        signal,
      ).catch(() => undefined);
      const target =
        typeof history?.back?.url === "string" ? history.back.url : undefined;
      if (target && /^https?:/i.test(target)) {
        const verdict = checkNavigationTarget(target, {
          allowPrivateHosts: options.allowPrivateHosts,
        });
        if (!verdict.allowed) throw new NavigationRefusedError(verdict.reason);
      }
      return pageAction<ActionResult>(
        "computer_back",
        "/back",
        botId,
        actor,
        target ? { targetUrl: target } : {},
        target ? { expectedUrl: target } : {},
        signal,
      );
    },

    fill: (
      botId: string,
      actor: ActionActor,
      input: FillInput,
      signal?: AbortSignal,
    ) => fill(botId, actor, input, signal),

    warm(botId: string) {
      return post<WarmResult>(botId, "/warm", {}, undefined, WARM_BACKSTOP_MS);
    },

    invalidatePolicy(botId?: string) {
      if (botId) policies.delete(botId);
      else policies.clear();
    },

    /**
     * The file tools, governed like everything else.
     *
     * The read is governed too, unlike reading a page. A page was permitted when it was opened; the
     * workspace accumulates whatever a Bot has saved across every task it has ever run, so which of
     * those files it may read back is a real question for a deployment to be able to answer.
     */
    readFile(botId: string, actor: ActionActor, input: ReadFileInput) {
      return govern(
        "computer_read_file",
        botId,
        actor,
        { filePath: input.path },
        () => post<ReadFileResult>(botId, "/files/read", input),
      ).then((result) =>
        // A workspace file is whatever the Bot downloaded or was sent, so it is outside content.
        withUntrustedNotice(result, "workspace file", ["text"]),
      );
    },

    /**
     * The bytes leave the workspace, which is a different permission from letting a Bot read them.
     *
     * The decision and audit row use `computer_download_file` / `download_file`; a deployment can
     * therefore allow `computer_read_file` while refusing this, or the reverse. The computer returns
     * a stream, so the size limit is enforced there before any bytes are sent.
     */
    downloadFile(
      botId: string,
      actor: ActionActor,
      input: DownloadFileInput,
      signal?: AbortSignal,
    ) {
      return govern(
        "computer_download_file",
        botId,
        actor,
        { filePath: input.path, ...(signal ? { signal } : {}) },
        async () => {
          const download = await transport.download(
            await locate(botId),
            botId,
            `/files/download?path=${encodeURIComponent(input.path)}`,
            signal,
            DOWNLOAD_BACKSTOP_MS,
          );
          return {
            ...download,
            name: describeFile(input.path).name || "download",
          };
        },
      );
    },

    /**
     * Listing is governed too, and for the same reason the read is: what a Bot has accumulated over
     * every task it has run is worth being able to restrict. A rule denying a folder hides it from the
     * listing as well as from reads, which is the consistent answer.
     */
    listFiles(botId: string, actor: ActionActor, input: ListFilesInput) {
      return govern(
        "computer_list_files",
        botId,
        actor,
        { filePath: input.path ?? "." },
        () => post<ListFilesResult>(botId, "/files/list", input),
      );
    },

    /**
     * A command, judged before it runs.
     *
     * The same four steps as a click: resolve, decide, record, act. The policy sees the command
     * text, so a deployment can refuse a shell outright with `intent == "run_command"` or refuse
     * particular commands, and either way the attempt is a row in the trail whether or not it ran.
     */
    runCommand(
      botId: string,
      actor: ActionActor,
      input: RunCommandInput,
      caller?: AbortSignal,
    ) {
      return govern(
        "computer_run_command",
        botId,
        actor,
        { command: input.command, ...(caller ? { signal: caller } : {}) },
        () =>
          post<RunCommandResult>(
            botId,
            "/exec",
            input,
            caller,
            COMMAND_BACKSTOP_MS,
          ),
      ).then((result) =>
        // What a command prints can be anything it fetched, so the output is marked.
        withUntrustedNotice(result, "command output", ["stdout", "stderr"]),
      );
    },

    writeFile(botId: string, actor: ActionActor, input: WriteFileInput) {
      return govern(
        "computer_write_file",
        botId,
        actor,
        { filePath: input.path },
        () => post<WriteFileResult>(botId, "/files/write", input),
      );
    },
  };
}

/** What an action's run is handed beside the address: this computer's run, asked once. */
type GovernedRun = { session: () => Promise<string | undefined> };

/**
 * The policy context for one action.
 *
 * Every field is bound, present or not.
 *
 * A missing one is not an absent field to CEL, it is an unknown identifier, and cel-js throws on
 * those. A thrown deny rule counts as a match, on purpose, so that a mistyped deny refuses rather
 * than quietly permitting. Together those two correct behaviours produced a wrong one: a rule
 * naming a field this action does not have refused the action.
 *
 * `deny: contains(command, "rm -rf")` is the example the docs give, and while `command` was spread
 * in only for a shell call, that rule threw on every click, keypress, navigation and file read in
 * the deployment and refused all of them. So did any rule naming `key`, `file` or `element` from an
 * action that has none.
 *
 * Neutral rather than absent: `contains("", "rm -rf")` is false, which is the honest answer to "is
 * this click running rm -rf". The audit row still omits what did not happen, because a trail should
 * not claim a click had a command.
 */
function policyContext(input: {
  toolName: string;
  botId: string;
  actor: ActionActor;
  pageUrl: string;
  intent: PolicyContext["intent"];
  element: SnapshotElement | undefined;
  key: string | undefined;
  filePath: string | undefined;
  command: string | undefined;
}): PolicyContext {
  const { element } = input;
  return {
    tool: { name: input.toolName },
    bot: { id: input.botId },
    actor: { id: input.actor.id },
    page: { url: input.pageUrl, host: hostOf(input.pageUrl) },
    ...(input.intent ? { intent: input.intent } : {}),
    key: input.key ?? "",
    element: element
      ? {
          ref: element.ref,
          role: element.role,
          name: element.name,
          type: element.type ?? "",
        }
      : { ref: "", role: "", name: "", type: "" },
    file: input.filePath
      ? describeFile(input.filePath)
      : { path: "", name: "", extension: "" },
    command: input.command ?? "",
    initiator: policyInitiator(input.actor.initiator),
    // Neutral, like the fields above: this is not an MCP call, but a `deny: mcp.effect == "write"`
    // names `mcp`, and cel-js throws on an unbound identifier — which fails closed and would refuse
    // every browser action the moment an operator wrote a rule about their tools. Empty server and
    // tool and an empty effect match no MCP rule, so a boundary drawn around MCP leaves the browser
    // alone. The MCP context carries the browser fields empty for the mirror of this reason.
    mcp: { server: "", tool: "", effect: "" },
  };
}

/** An acting result's page is whatever the page says it is, so it is marked like a page read. */
function markPage<T>(result: T): T {
  if (!result || typeof result !== "object" || !("page" in result))
    return result;
  return withUntrustedNotice(
    result as T & object,
    "web page",
    ACTION_PAGE_FIELDS,
  ) as T;
}

/**
 * Split a path into the parts a rule wants to match on.
 *
 * Lower-cased, because a rule forbidding `.env` must also catch `.ENV`; the
 * operator should have anticipated. Same reasoning as the case-insensitive `contains` in policy.ts.
 */
export function describeFile(path: string): {
  path: string;
  name: string;
  extension: string;
} {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    // A leading dot is the whole name of a dotfile, not an extension: `.env` has no extension, and the
    // rule for it is written against `name`.
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : "",
  };
}

/**
 * One audit row for one decision.
 *
 * Deliberately absent: the text that was typed. The row says which field was filled and
 * how many characters went into it, and never the value, because a form field is where a password, a
 * card number and a one-time code live. `audit.ts` would redact a key literally called `text`, but
 * relying on that would mean the secret was placed in the payload and caught on the way past; it is
 * simpler and stronger for it never to be put there. `element.name` is a label a page displays, not
 * something a person typed, so it is safe and it is the part an investigator actually needs.
 */
/**
 * What an action does, from what the gateway already knows.
 *
 * Derived here rather than passed in by each call site, so a new acting route cannot arrive
 * without an intent and fall outside every rule written in terms of one.
 *
 * Enter and Space are activations. They press whatever has focus, so a rule about activation must
 * cover keypresses as well as clicks.
 */
const ACTIVATING_KEYS = new Set(["Enter", "NumpadEnter", "Space", " "]);

/**
 * What a person's mouse and keyboard produce, and the whole of what `/human/<kind>` may name.
 *
 * A set rather than the union type alone, because the type is erased before the value gets here: the
 * route parses a JSON body and casts it to the input shape, so the check has to exist at runtime on
 * the side that builds the path.
 */
const HUMAN_GESTURES = new Set(["click", "type", "key", "scroll"]);

/**
 * The roles an element takes a value in. Anything else a "type" lands on is pressed instead: a
 * checkbox typed into is ticked, a button given to `computer_select` or `computer_upload` is not a
 * field at all.
 */
const VALUE_ROLES = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "spinbutton",
]);

/** The tools that put a value into an element, and so "type", only while the element takes one. */
const VALUE_TOOLS = new Set([
  "computer_type",
  "computer_select",
  "computer_upload",
  "computer_fill",
]);

/**
 * What an action does to the element it was resolved to.
 *
 * `intentOf` says what a tool does in general; this says what it does here. A prompt-injected
 * `computer_select {ref: <the "Delete account" button>}` is a press, and a rule against activating
 * that button has to fire on it, so a value-putting tool aimed at anything that does not take a
 * value (or at an element the server could not resolve) is decided as `activate`.
 */
export function intentFor(
  toolName: string,
  key: string | undefined,
  element: Pick<SnapshotElement, "role"> | undefined,
): PolicyContext["intent"] {
  const intent = intentOf(toolName, key);
  if (
    intent === "type" &&
    VALUE_TOOLS.has(toolName) &&
    !VALUE_ROLES.has(element?.role ?? "")
  )
    return "activate";
  return intent;
}

export function intentOf(
  toolName: string,
  key: string | undefined,
): PolicyContext["intent"] {
  switch (toolName) {
    case "computer_click":
    // Ticking a box is a click on it, and accepting a dialog is pressing its OK.
    case "computer_check":
    case "computer_dialog":
      return "activate";
    // Choosing an option, filling a form or sending a file puts a value into the page, as typing does.
    case "computer_select":
    case "computer_fill":
    case "computer_upload":
      return "type";
    case "computer_back":
      return "navigate";
    case "computer_hover":
    case "computer_tabs":
      return "read";
    case "computer_key":
    // A type carrying `submit` ends in Enter, and the same reasoning applies to it: what the
    // keypress does is press whatever the form activates, whichever tool asked for it.
    case "computer_type":
      return key && ACTIVATING_KEYS.has(key) ? "activate" : "type";
    case "computer_navigate":
      return "navigate";
    case "computer_read":
    case "computer_snapshot":
    case "computer_screenshot":
    case "computer_scroll":
      return "read";
    case "computer_read_file":
      return "read_file";
    case "computer_download_file":
      return "download_file";
    case "computer_write_file":
      return "write_file";
    case "computer_run_command":
      return "run_command";
    case "computer_list_files":
      return "list_files";
    default:
      return undefined;
  }
}

async function write(
  auditStore: AuditStore,
  entry: {
    toolName: string;
    botId: string;
    actor: ActionActor;
    element: SnapshotElement | undefined;
    ref: string | undefined;
    /** Which key, for a keypress. Recorded because a keypress can act without naming a button. */
    key?: string | undefined;
    filePath: string | undefined;
    pageUrl: string;
    decision: PolicyDecision;
    /** The command a shell call ran, so the trail says what was run and not merely that something was. */
    command?: string;
    /** Set only when a permitted action was attempted and did not succeed. */
    failure?: string;
    /** Set when that non-success was a person pressing Stop, so the row is typed a stop, not a failure. */
    stopped?: boolean;
  },
) {
  await recordAuditEvent(auditStore, {
    // A failure is its own kind of event, not a variant of "allowed": the whole point of the extra row
    // is that a reader can tell an action that happened from one that was permitted and then did not.
    // A stop is a third kind again: the action did not happen, but nothing broke, so it is neither a
    // failure to be counted as an outage nor an action that was carried out.
    eventType: entry.stopped
      ? "computer.action_stopped"
      : entry.failure
        ? "computer.action_failed"
        : entry.decision.allowed
          ? "computer.action_allowed"
          : "computer.action_refused",
    targetType: "computer",
    targetId: entry.botId,
    initiator: entry.actor.initiator,
    // Only ever a real users row. The audit table has a foreign key to it, so writing the local
    // development actor's id here makes every action fail on a constraint violation instead of being
    // recorded. Who it was is in the payload either way.
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      action: entry.toolName,
      bot: entry.botId,
      actor: entry.actor.id,
      page: entry.pageUrl,
      ref: entry.ref ?? null,
      /*
       * The key, where there is one. A keypress can submit a form from inside a text field, so the
       * element it was aimed at is not always the thing it acted on. Without the key, the trail
       * cannot distinguish a form-submitting Enter from typing a letter.
       */
      ...(entry.key ? { key: entry.key } : {}),
      // The path, never the contents. A Bot writes down what it was told, so a file body is exactly as
      // sensitive as text typed into a form field, and for the same reason it is not put here.
      ...(entry.filePath ? { file: entry.filePath } : {}),
      /*
       * The command, in full, and its output never.
       *
       * The opposite call from the file body above, deliberately. A command IS the action, so a
       * trail recording that a Bot "ran something" answers nothing anyone would ask it. Its output
       * is the file body of this pair, and stays out.
       */
      ...(entry.command ? { command: entry.command } : {}),
      /*
       * The element, where the action named one.
       *
       * KEYED ON THE REF, not on the kind of action. An unresolved element is worth recording
       * plainly rather than as an absent field that reads like a logging gap, but that only applies
       * when the Bot pointed at something and the server could not say what: a ref it holds and the
       * snapshot no longer does. Deciding it by elimination instead put "not in the current
       * snapshot" on every navigation, every file read and every command, which is the reverse of
       * the intent. Those actions did not fail to identify an element; they never had one, and a
       * trail that says otherwise sends a reader looking for a snapshot that was never taken.
       */
      element: entry.element
        ? {
            role: entry.element.role,
            name: entry.element.name,
            ...(entry.element.type ? { type: entry.element.type } : {}),
          }
        : entry.ref
          ? "not in the current snapshot"
          : undefined,
      ...(entry.failure ? { failure: entry.failure } : {}),
      decision: {
        allowed: entry.decision.allowed,
        mode: entry.decision.mode,
        source: entry.decision.source,
        rule: entry.decision.matched,
        /** Present so the trail explains a dry-run row that was recorded as refused but still ran. */
        carriedOut: entry.decision.forward,
      },
    },
  });
}

/**
 * The host a rule can match on, or empty.
 *
 * Empty means "no page", which is the accurate answer before a Bot has snapshotted anything, and it is
 * the only case that occurs in practice: the URL comes from Playwright's own `page.url()` by way of the
 * snapshot cache. Worth stating explicitly because a `page.host == "..."` deny rule would not match an
 * empty host, so a boundary that must not be evadable should also key on the tool, the element or the
 * file rather than on the host alone.
 */
/**
 * One row for a handover.
 *
 * Separate from `write` because a handover has no element, no file and no policy decision, forcing it
 * through the same shape would mean inventing a decision that was never asked for, and a row claiming
 * a policy allowed something it never saw is exactly the kind of comfortable fiction this trail exists
 * to avoid.
 */
/** Tells the listener without waiting on it, and never lets it throw into the handover. */
function notifyControl(
  listener: ComputerGatewayOptions["onControlEvent"],
  event: Omit<ComputerControlEvent, "userId"> & { actor: ActionActor },
) {
  if (!listener) return;
  const { actor, ...rest } = event;
  try {
    listener({
      ...rest,
      ...(actor.userId ? { userId: actor.userId } : {}),
    });
  } catch (error) {
    console.warn("computer control listener failed", error);
  }
}

async function writeControlEvent(
  auditStore: AuditStore,
  eventType:
    | "computer.help_requested"
    | "computer.help_cancelled"
    | "computer.control_taken"
    | "computer.control_released"
    | "computer.secret_requested"
    | "computer.secret_supplied"
    | "computer.secret_cancelled"
    | "computer.stopped"
    | "computer.reset"
    | "computer.updated",
  entry: {
    botId: string;
    actor: ActionActor;
    reason?: string;
  },
) {
  await recordAuditEvent(auditStore, {
    eventType,
    targetType: "computer",
    targetId: entry.botId,
    initiator: entry.actor.initiator,
    ...(entry.actor.userId ? { actorUserId: entry.actor.userId } : {}),
    payload: {
      bot: entry.botId,
      actor: entry.actor.id,
      ...(entry.reason ? { reason: entry.reason } : {}),
    },
  });
}

/** The fields of a page read that come from the page itself. */
const PAGE_FIELDS = ["title", "text"] as const;
const SNAPSHOT_FIELDS = ["title", "elements"] as const;

/** A two-step login can take two page loads and a code; this outlasts the computer's own waits. */
const SIGN_IN_BACKSTOP_MS = 75_000;

/** A fill is many fields, each with its own action timeout, in one request. */
const FILL_BACKSTOP_MS = 180_000;

/** A cold browser launch on a small machine, and then some. */
const WARM_BACKSTOP_MS = 90_000;

/** How long a located computer address is reused. See `locate` in the gateway. */
const LOCATE_CACHE_MS = 30_000;

/** How long the policy read for a Bot is reused. */
const POLICY_CACHE_MS = 5_000;

/** The fields of an acting result that come from the page itself. */
const ACTION_PAGE_FIELDS = ["page", "tabs", "dialog"] as const;

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
