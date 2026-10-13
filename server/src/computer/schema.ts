import type {
  BrowserChallenge,
  ComputerControlState,
} from "../../../shared/computer-control";
/**
 * The computer-use contract.
 *
 * One place that says what a tool call looks like, so neither the surface nor the computer has to
 * read the other's code to find out. Changing a name or a parameter here is a breaking change for
 * both sides: add, do not repurpose.
 *
 * The read-only tools sit alongside the acting ones, and every acting tool goes through the gateway,
 * so each is policy checked and written to the audit trail before it runs. Names are never
 * repurposed: this file only ever grows.
 */

/**
 * Every tool the computer exposes.
 *
 * Ordered read-only first, then acting. `COMPUTER_ACTING_TOOLS` below is what the gateway uses to
 * decide which calls need a policy decision, so add acting tools to both lists.
 */
export const COMPUTER_TOOLS = [
  "computer_navigate",
  "computer_screenshot",
  "computer_read",
  "computer_snapshot",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_read_file",
  "computer_download_file",
  "computer_write_file",
  "computer_list_files",
  "computer_fill",
  "computer_select",
  "computer_check",
  "computer_upload",
  "computer_hover",
  "computer_dialog",
  "computer_tabs",
  "computer_back",
] as const;

/**
 * The tools that change something, or reach something that needs deciding on.
 *
 * These are the calls the gateway must decide on. Reading a PAGE a Bot has already been allowed to
 * open is not a new decision; clicking "Confirm payment" on it is.
 *
 * Every workspace file tool is here, including the read and the download. That differs from
 * `computer_read`, which is ungoverned, and it is deliberate: a page was already permitted when it
 * was opened, whereas the workspace accumulates whatever a Bot has put in it across every task it
 * has ever run, so "which files may this Bot read, list, download or write" is a question a
 * deployment genuinely needs to be able to answer.
 */
export const COMPUTER_ACTING_TOOLS = [
  // Navigation is governed too, and not only guarded. The client's target guard refuses a forbidden
  // address on its own, which stops the request and writes nothing. That leaves the trail silent
  // about an attempt to reach the cloud metadata endpoint, the single most security-relevant thing a
  // Bot can try, while ticking a radio button is recorded. Governing it puts both in the trail.
  "computer_navigate",
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_scroll",
  "computer_read_file",
  "computer_download_file",
  "computer_write_file",
  "computer_list_files",
  // A whole form at once. Governed field by field under the single-field tools' names (see
  // `ComputerGateway.fill`), so a rule about typing or ticking applies inside a fill as well.
  "computer_fill",
  "computer_select",
  "computer_check",
  // A file leaves the workspace for a website: governed with the file's path, like a download.
  "computer_upload",
  "computer_hover",
  // Accepting "Are you sure you want to delete this?" is pressing its OK button.
  "computer_dialog",
  "computer_tabs",
  "computer_back",
] as const;

export type ComputerActingToolName = (typeof COMPUTER_ACTING_TOOLS)[number];

export function isActingTool(name: string): name is ComputerActingToolName {
  return (COMPUTER_ACTING_TOOLS as readonly string[]).includes(name);
}

export type ComputerToolName = (typeof COMPUTER_TOOLS)[number];

export type NavigateInput = { url: string; toolCallId?: string };

/** A JavaScript dialog the page is paused on, or one that was dismissed for nobody answering. */
export type PageDialog = {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
  /** Dismissed after a minute without an answer: nothing is left to answer. */
  dismissed?: true;
};

/**
 * The page an acting call left behind. Every acting result carries one, so the Bot does not spend
 * a second round trip on a snapshot to find out what its click did.
 *
 * `elements` are compact lines, one per element (`e5 textbox "Email" = "a@b.c"`); with `changed`
 * they list only what is new or different since the previous snapshot of the same page, and refs
 * from that earlier list stay valid with this `snapshotId`.
 */
export type PageReport = {
  url: string;
  title: string;
  /** The HTTP status, when the action navigated the page. */
  status?: number;
  /** Send this with the next action's refs. */
  snapshotId: number;
  elements: string[];
  changed?: true;
  dialog?: PageDialog;
  /** The action opened a new tab or window, which is now the active page. */
  opened?: { url: string };
  /** A file the action downloaded, saved in the workspace. */
  download?: { path: string; bytes: number };
  /** The page had not finished loading; this is what it showed so far. */
  loading?: true;
  /** Things worth knowing that are not elements: a download still saving, a pop-up note. */
  notes?: string[];
};

export type NavigateResult = {
  /** The untrusted-content notice for the page's own fields. See untrusted-content.ts. */
  untrusted?: string;
  challenge?: BrowserChallenge;
  url: string;
  title: string;
  /**
   * The readable text of the page, truncated.
   *
   * Navigation returns content because a Bot that can open a page but not read it can only answer
   * "I opened it, go and look yourself", which is worse than not having the tool: the person asked
   * a question and got homework. The screenshot is for the human to watch; this is what the Bot
   * reads. They are not interchangeable, and a picture is not something a model should be made to
   * squint at to answer "what is the top story".
   */
  text: string;
  /** True when the page was longer than the extract, so the Bot can say so rather than guess. */
  truncated: boolean;
  /** Wall-clock ms the navigation took, for the progress line in the transcript. */
  elapsedMs: number;
  /** The page as it arrived: status, elements and refs to act on without a snapshot. */
  page?: PageReport;
  stillLoading?: boolean;
  note?: string;
  /** Said when the Bot navigated inside a pop-up window the site opened. */
  warning?: string;
};

export type ScreenshotResult = {
  /** PNG, base64. The transcript renders it; nothing else interprets it. */
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
  /** A desktop frame is a JPEG and says so. Absent, PNG, which is what a page screenshot has always been. */
  format?: "png" | "jpeg";
  /**
   * The page this is a picture of, or `about:blank` for a browser that has not been sent anywhere.
   *
   * Optional because it was added after the first computers shipped, and an agent-computer that has
   * not been redeployed does not send it. Treat a missing value as "some page", never as blank: the
   * failure that matters is a real screenshot being hidden behind a placeholder.
   */
  url?: string;
};

/** The current page as text, without opening anything. Same shape as a navigation, minus the trip. */
export type ReadResult = Omit<NavigateResult, "elapsedMs">;

/**
 * One thing on the page a Bot can act on.
 *
 * This is the accessibility-tree view, not the pixels: a Bot fills in a form by reading a list of
 * labelled fields and naming one, which is why form-filling needs no vision model. See the build
 * doc's open decision 2 (accessibility tree first, pixels as fallback).
 */
export type SnapshotElement = {
  /** Opaque handle, valid only for the snapshot that produced it. Never construct one. */
  ref: string;
  /** ARIA role where the page declares one, otherwise the tag name. */
  role: string;
  /** What a person reads as this control's label, resolved the way a screen reader resolves it. */
  name: string;
  /** Current contents, for form controls. Lets a Bot tell an empty field from a filled one. */
  value?: string;
  /** An `input`'s type, so a Bot does not try to type into a checkbox. */
  type?: string;
  disabled?: boolean;
  checked?: boolean;
  /** A drop-down's choices, by label. */
  options?: string[];
};

export type SnapshotResult = {
  untrusted?: string;
  challenge?: BrowserChallenge;
  /**
   * Which snapshot these refs belong to. Must be sent back with every action.
   *
   * This field makes refs from superseded snapshots refusals instead of actions.
   * A page that re-rendered between the snapshot and the click has moved its controls, and the
   * failure mode without this check is not an error, it is clicking the wrong button.
   */
  snapshotId: number;
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** True when the page had more interactive elements than the snapshot describes. */
  truncated: boolean;
};

/** Common to every acting call: which element, and which snapshot the ref came from. */
export type ActionTarget = { ref: string; snapshotId: number };

export type ClickInput = ActionTarget;
export type TypeInput = ActionTarget & {
  text: string;
  /** Press Enter afterwards. How a Bot submits a single-field form without hunting for the button. */
  submit?: boolean;
};
export type KeyInput = Partial<ActionTarget> & { key: string };
/** With a ref: scroll it into view, or with `deltaY` too, scroll inside the panel it is in. */
export type ScrollInput = { deltaY?: number } & Partial<ActionTarget>;
/** `option` is the visible label or the value. */
export type SelectInput = ActionTarget & { option: string };
export type CheckInput = ActionTarget & { checked: boolean };
/** `path` is relative to the Bot's workspace. */
export type UploadInput = ActionTarget & { path: string };
export type HoverInput = ActionTarget;
export type DialogInput = { accept: boolean; text?: string };
export type TabsInput = { action: "list" | "switch" | "close"; index?: number };

/** One field of a fill: a ref and exactly one thing to put in it. */
export type FillField = {
  ref: string;
  text?: string;
  checked?: boolean;
  option?: string;
  file?: string;
};

/** A whole page of fields in one call, then a click on a ref or a submit of the form. */
export type FillInput = {
  fields: FillField[];
  then?: { click: string } | { submit: true };
  snapshotId: number;
};

/**
 * What an action reports back.
 *
 * Typed text is absent. This value is read by the model and written to the
 * audit trail, and the contents of a form field is exactly where a password, a card number or a
 * one-time code lives. The caller already knows what it sent, so echoing it buys nothing and puts a
 * secret into two places that keep it. `characters` is enough to confirm the field was filled.
 */
export type ActionResult = {
  action:
    | "click"
    | "type"
    | "key"
    | "scroll"
    | "select"
    | "check"
    | "upload"
    | "hover"
    | "fill"
    | "dialog"
    | "tabs"
    | "back";
  ref?: string;
  /**
   * The label of the element acted on, as the gateway resolved it.
   *
   * The ref is an internal handle, so the response carries the readable element label.
   */
  element?: { role: string; name: string };
  /** For `type`: how much was entered, never what. */
  characters?: number;
  submitted?: boolean;
  key?: string;
  deltaY?: number;
  /** Where the page ended up, which is how a Bot notices that its click navigated. */
  url: string;
  elapsedMs: number;
  /** The page the action produced. Absent only from a computer that predates it. */
  page?: PageReport;
  /** For `select` (and a `type` carried out as one): the option chosen, by label. */
  chosen?: string;
  /** For `check`. */
  checked?: boolean;
  /** A `type` into a drop-down or checkbox is carried out with the tool that fits; this names it. */
  routed?: string;
  note?: string;
  /** For `upload`: the workspace file sent. */
  path?: string;
  /** For `dialog`: what was answered. */
  accepted?: boolean;
  dialog?: { type: string; message: string };
  /** For `tabs`. */
  tabs?: Array<{ index: number; url: string; title: string; active: boolean }>;
  /** For `back`: false when there was no earlier page. */
  wentBack?: boolean;
  /** A challenge the page showed after the action; the takeover request is already open. */
  challenge?: BrowserChallenge;
};

/**
 * What a fill reports: the fields that went in, the first that did not (and why), or the one the
 * policy refused, and what happened afterwards.
 */
export type FillResult = Omit<ActionResult, "action"> & {
  action: "fill";
  filled: Array<{
    index: number;
    ref: string;
    kind: "text" | "checked" | "option" | "file";
    element?: { role: string; name: string };
    characters?: number;
    chosen?: string;
    checked?: boolean;
    routed?: string;
  }>;
  /** The field (or `then`) that did not work. Fields after it were not attempted. */
  failed?: {
    index: number | "then";
    ref?: string;
    error: string;
    problem?: string;
    stale?: boolean;
  };
  /** The field (or `then`) a rule refused. Nothing from it on was sent to the computer. */
  refused?: {
    index: number | "then";
    ref: string;
    element?: { role: string; name: string };
    reason: string;
    rule: string | null;
  };
  /** What `then` did. */
  afterwards?: { clicked: string } | { submitted: true };
};

/** The browser warmed: started if it was not running, and sent nowhere. */
export type WarmResult = { warm: true; launched: boolean; ms: number };

/** Absent path means the whole workspace. */
export type ListFilesInput = { path?: string };

/** One thing in the workspace. Folders included, so a Bot can see the shape, not just the leaves. */
export type WorkspaceEntry = {
  /** Relative to the workspace root, which is the only form a request may use. */
  path: string;
  kind: "file" | "folder";
  bytes?: number;
  /** When a file was last written, ISO 8601 from its mtime. Files only, like `bytes`. */
  modifiedAt?: string;
};

export type ListFilesResult = {
  path: string;
  entries: WorkspaceEntry[];
  /** True when there was more in the workspace than the listing describes. */
  truncated: boolean;
};

export type ReadFileInput = { path: string };
export type DownloadFileInput = { path: string };
export type ReadFileResult = {
  untrusted?: string;
  path: string;
  text: string;
  /** True when the file was longer than the extract, so the Bot can say so rather than guess. */
  truncated: boolean;
  /** The file's real size, even when the text was cut. */
  bytes: number;
};

/**
 * A command for the Bot's computer to run.
 *
 * The whole command as one string, because a shell's usefulness is pipes, redirection and `&&`, and
 * a shape that took a binary plus arguments would be a worse shell wearing the name.
 */
export type RunCommandInput = {
  command: string;
  /** Capped by the computer. Absent takes its default. */
  timeoutMs?: number;
};

/**
 * What running one reports back.
 *
 * `truncated` and `timedOut` are separate from the exit code because they are different facts about
 * the same run: a command can succeed and still have had its output cut, and one that was killed on
 * the clock never produced an exit code of its own.
 */
export type RunCommandResult = {
  untrusted?: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  elapsedMs: number;
};

export type WriteFileInput = {
  path: string;
  contents: string;
  /** Add to the end instead of replacing, for a Bot keeping a running log. */
  append?: boolean;
};

/**
 * What a write reports back.
 *
 * The contents are not echoed, for the same reason typed text is not: a Bot may well be saving
 * something it was told in confidence, and a value repeated into the transcript and the audit trail
 * now lives in three places instead of one.
 */
export type WriteFileResult = {
  path: string;
  bytes: number;
  appended: boolean;
};

/**
 * Who is driving the computer.
 *
 * The expand overlay is where control lands. One browser, two possible drivers, never at once: while a person holds the wheel every acting call from the Bot
 * is refused rather than queued, because a queued click arrives after the person has moved on.
 */
export type ControlHolder = "bot" | "human";

export type ControlState = ComputerControlState;

/**
 * A value the Bot needs and must not be told: a password, a one-time code.
 *
 * `label` is what the person is asked for, and it is the only part of this that is ever stored or
 * recorded. `ref` names the field it goes in, because a secret typed into whatever happens to have
 * focus goes nowhere when nothing does, and reports success while doing it.
 */
export type SecretRequest = { label: string; ref: string; snapshotId: number };

/**
 * What supplying a secret reports back.
 *
 * `characters` and nothing else. The value is not returned, not logged and not audited: the point of
 * the whole mechanism is that it exists in one place, the page it was typed into.
 */
/**
 * One Bot's computer, as the admin surface lists it.
 *
 * A Bot that has a profile has a computer, whether or not a browser is running for it this second.
 * That distinction is the point of the page: "not running" is the normal resting state of a computer
 * nobody is using, and it is not a fault.
 */
export type ComputerProfile = {
  botId: string;
  running: boolean;
  startedAt: string | null;
  /**
   * The host its traffic leaves through, or null for direct.
   *
   * Host only. A proxy is usually handed out as a URL with credentials in it, and this field is
   * read by people and rendered in a browser.
   */
  egress: string | null;
};

/**
 * A login typed into the Bot's current page by the computer itself.
 *
 * `origin` is the site the person was asked to sign in to. The computer refuses to type anything when
 * the page is on a different origin, so a login cannot be carried to a page that redirected elsewhere.
 */
export type SignInFillInput = {
  origin: string;
  username?: string;
  /** Absent for a page that asks for a one-time code alone (an SMS confirmation after the login). */
  password?: string;
  /** A one-time code the person entered alongside, typed if the site asks for one. */
  code?: string;
};

/**
 * What the Bot's page asks for, read by the computer before a person is shown a sign-in form. The
 * origin is where the form really is (an identity provider the site redirected to, say), and the icon
 * is the site's own, fetched by the Bot's browser and handed over as a small data URL.
 */
export type SignInProbe = {
  url: string;
  origin: string;
  host: string;
  form: "login" | "username" | "code" | "none";
  icon?: string;
};

/** What the computer reports. No field here ever carries a credential. */
export type SignInFillResult = {
  submitted: boolean;
  /** Whether the page still shows a password field after submitting: the plainest sign of a failure. */
  passwordFieldVisible: boolean;
  url: string;
  error?: string;
};

export type SecretResult = {
  supplied: boolean;
  characters: number;
  url: string;
};

/** What a person did with their mouse or keyboard. Coordinates are viewport pixels. */
export type HumanInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; deltaY?: number };

/**
 * What a person's input reports back.
 *
 * Never the text. A takeover exists so a person can type the thing the Bot must not have, a password,
 * a one-time code. That value goes from their keyboard to the browser and stops; it is not returned
 * here, not written to the audit trail, and not on any path the model can read.
 */
export type HumanInputResult = {
  action: "human_click" | "human_type" | "human_key" | "human_scroll";
  characters?: number;
  key?: string;
  deltaY?: number;
  url: string;
};

/** Lifecycle states a Bot's computer can be in, as the UI must render them. */
export const COMPUTER_STATES = [
  "absent",
  "starting",
  "ready",
  "unreachable",
] as const;

export type ComputerState = (typeof COMPUTER_STATES)[number];

export type ComputerStatus = {
  botId: string;
  state: ComputerState;
  /** Set when state is "unreachable", in words a person can act on. */
  reason?: string;
  /**
   * The desktop this computer draws, when it has one.
   *
   * A computer with a desktop shows the whole screen on its live view, at this size, rather than the
   * page the Bot has open. The panel reads it to pick the frame it polls and the shape it reserves.
   */
  desktop?: { width: number; height: number };
  /**
   * Whether this Bot's browser is running, read without starting it.
   *
   * The panel draws a computer whose browser has stopped (closed by the computer's idle sweep, or
   * never started) as asleep, rather than asking it for a screenshot, which would start it again.
   * Absent when it cannot be told without waking something, which the panel treats as unknown.
   */
  browser?: "running" | "stopped";
};
