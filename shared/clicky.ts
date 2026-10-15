/**
 * Clicky Mode, which people know as "Show me how" (Greek «Δείξε μου πώς»): the protocol shared by the
 * server, the app and the HyperNoesis phone app. The code keeps the name Clicky; nothing a person
 * reads does.
 *
 * Clicky is a companion beside the screen of a Bot's computer. It points at the part of the screen
 * that matters, walks the person through a task one step at a time, and acts on the computer only
 * when the person says so. This file is types, limits and small pure helpers; the state machine is
 * `clicky-state.ts`, and the server validates commands with the zod schemas in
 * `server/src/clicky/schema.ts` (this directory has no dependencies of its own).
 *
 * Coordinates are NORMALIZED to the computer's screen, 0 to 1 on each axis, top-left origin. A desktop
 * frame is 1440×900 screen pixels and a page frame is viewport pixels scaled by the screencast, so a
 * normalized point fits the full viewer, the inline preview and a phone's thumbnail alike.
 *
 * The HyperNoesis app keeps a copy of this file (`apps/mobile/src/modules/noebot/clicky/protocol.ts`);
 * change both together.
 */

/** Where Clicky is. `awake` on the session says whether it is listening for the person at all. */
export const CLICKY_STATES = [
  "idle",
  "listening",
  "thinking",
  "guiding",
  "awaiting_permission",
  "acting",
  "paused",
  "stopped",
] as const;
export type ClickyState = (typeof CLICKY_STATES)[number];

/**
 * `guide` points and explains and never proposes an action. `act` may propose actions, and each one
 * still waits for the person's yes. Stop always drops back to `guide`.
 */
export const CLICKY_MODES = ["guide", "act"] as const;
export type ClickyMode = (typeof CLICKY_MODES)[number];

/** A point on the computer's screen, each axis 0–1 from the top-left. */
export type ClickyPoint = { x: number; y: number };

/** A box on the computer's screen, normalized like a point. */
export type ClickyRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * What Clicky draws over the screen.
 *
 * - `pointer`: Clicky's own cursor, beside the place to look. `approximate` when the model guessed the
 *   spot and no real element was found under it, so the caption can say "around here".
 * - `marker`: a numbered secondary point, for tours and alternatives.
 * - `highlight`: a box around an element.
 * - `caption`: a short line near a point, or near Clicky's pointer when `at` is absent.
 */
export type ClickyOverlay =
  | {
      kind: "pointer";
      id: string;
      at: ClickyPoint;
      label?: string;
      approximate?: boolean;
    }
  | {
      kind: "marker";
      id: string;
      at: ClickyPoint;
      index: number;
      label?: string;
    }
  | { kind: "highlight"; id: string; rect: ClickyRect; label?: string }
  | { kind: "caption"; id: string; at?: ClickyPoint; text: string };

export type ClickyStepStatus = "pending" | "current" | "done" | "skipped";

/** One step of a walkthrough: what to do, and where on the screen. */
export type ClickyStep = {
  id: string;
  title: string;
  detail?: string;
  status: ClickyStepStatus;
  overlays: ClickyOverlay[];
  /** The element this step is about, when Clicky found it on the page (an aria ref). */
  targetRef?: string;
};

/** A task broken into steps. Progress is kept, so a walkthrough resumes where it was. */
export type ClickyWalkthrough = {
  id: string;
  goal: string;
  steps: ClickyStep[];
  currentStepId: string | null;
  startedAt: string;
  updatedAt: string;
};

/**
 * Something Clicky would do on the computer, as the person's own input.
 *
 * `at` is where on the screen; `ref` is the element when it was found on the page, so the server can
 * look again just before acting. `label` is what the person reads ("the Search box").
 */
export type ClickyAction = (
  | {
      kind: "click";
      at: ClickyPoint;
      ref?: string;
      label: string;
      button?: "left" | "right";
      double?: boolean;
    }
  | {
      kind: "type";
      text: string;
      at?: ClickyPoint;
      ref?: string;
      label: string;
      /**
       * Press Enter once the text is in, as a separate key the guardrails rate on its own (a search
       * box is everyday; a form's submit is asked about). The text itself never holds a line break.
       */
      pressEnter?: boolean;
    }
  /** A key or a combination in Playwright's notation: `Enter`, `Control+L`. */
  | { kind: "key"; keys: string; label: string }
  /**
   * Open a web address in the browser's current tab, as typing it into the address bar would. An
   * https address only; everyday only when the person's own words named that site.
   */
  | { kind: "open"; url: string; label: string }
  | {
      kind: "scroll";
      at: ClickyPoint;
      deltaY: number;
      label: string;
      /** Bring this element into view instead of turning the wheel by `deltaY`. */
      ref?: string;
    }
) & {
  /**
   * What the model called it, when `label` was replaced with the element's own role and name as
   * the server found it on the page. Kept for the audit trail; the person reads `label`.
   */
  modelLabel?: string;
};

/**
 * How an action is treated, decided by the server's guardrails and never by the model.
 *
 * - `low`: may run on the person's "Allow for this session" without asking again.
 * - `confirm`: hard to undo (a submit, a send, closing a window); asked about every time.
 * - `yours`: only the person does this (a password, a code, a payment, a security setting, a
 *   CAPTCHA). Clicky points and the person acts.
 * - `blocked`: never done (a logout or lock shortcut, typing into a password field, guide-only).
 */
export type ClickyRisk = "low" | "confirm" | "yours" | "blocked";

export type ClickyProposal = {
  id: string;
  action: ClickyAction;
  /** Why Clicky wants to do it, in a short line for the person. */
  why: string;
  risk: ClickyRisk;
  /** Why the guardrails rated it the way they did, for `confirm`, `yours` and `blocked`. */
  riskReason?: string;
  /**
   * What the server found at the action's place when it was proposed (the page, and the element's
   * role and name). The action is refused if that has changed by the time the person says yes.
   */
  seen?: ClickySeen;
  createdAt: string;
  expiresAt: string;
};

/**
 * The page an action was proposed on and, when one was read there, the element: as the server read
 * them. The page is always there; the element only when the place was on the page.
 */
export type ClickySeen = {
  url: string;
  /**
   * The page's site (its registrable domain, e.g. `gov.gr` for `www.gov.gr` and
   * `dilosi.services.gov.gr`), as the server worked it out. "Allow for this session" is bound to it.
   */
  site?: string;
  role?: string;
  name?: string;
  ref?: string;
};

/**
 * Why Clicky is showing. `person` is somebody asking; the others are the Bot needing the person on
 * its computer, which opens Clicky by itself (`requestId` is the handover, sign-in, secret or
 * approval request it is about), and `follow_up` is Clicky saying what happened after a task.
 */
export type ClickyTriggerKind =
  | "person"
  | "takeover"
  | "sign_in"
  | "secret"
  | "approval"
  | "challenge"
  | "follow_up";

export type ClickyTrigger = {
  kind: ClickyTriggerKind;
  requestId?: string;
  /** The Bot's own words for what it needs, shown as given. */
  reason?: string;
  /** The element the Bot asked the person to use (`point_at` on a help request). */
  targetRef?: string;
};

/** Triggers where only the person may act: Clicky never offers "Do it for me" for these. */
export const CLICKY_PERSON_ONLY_TRIGGERS: readonly ClickyTriggerKind[] = [
  "sign_in",
  "secret",
  "challenge",
];

export type ClickyTurn = {
  role: "person" | "clicky";
  text: string;
  at: string;
};

/**
 * "Allow for this session": once the person says yes, everyday (low-risk) actions run without asking
 * again until Clicky sleeps, is stopped, goes back to guide only, the Bot needs the person, or two
 * hours pass. Anything hard to undo is still asked about every time, and what is the person's to do
 * never becomes an action at all.
 */
export type ClickyTaskGrant = {
  scope: "session";
  grantedAt: string;
  expiresAt: string;
  /**
   * The site the yes was given on (a registrable domain, or the host when the server named none);
   * actions on another site are asked about again.
   */
  host?: string;
};

export type ClickySession = {
  id: string;
  botId: string;
  state: ClickyState;
  /** The state to go back to on resume. */
  resumeState: ClickyState | null;
  mode: ClickyMode;
  awake: boolean;
  trigger: ClickyTrigger | null;
  walkthrough: ClickyWalkthrough | null;
  /** Overlays not tied to a step: an answer's pointer, or markers set through the bridge. */
  overlays: ClickyOverlay[];
  proposal: ClickyProposal | null;
  /**
   * Clicky's latest line. `text` is the model's words, already in the person's language; `notice` is
   * one of Clicky's own fixed lines, which each client draws in its own language (and then `text` is
   * extra detail, or empty). `final` is false while the model's words are still arriving.
   */
  reply: {
    text: string;
    final: boolean;
    notice?: ClickyNotice;
    /** Words a notice names (`{{label}}`, `{{host}}`, `{{key}}`), for the client to put in its own sentence. */
    params?: Record<string, string>;
  } | null;
  /** The last turns, newest last, at most `CLICKY_TRANSCRIPT_LIMIT`. */
  transcript: ClickyTurn[];
  grant: ClickyTaskGrant | null;
  /** The last thing that went wrong; cleared by the next success. `detail` is for the curious. */
  error: { notice: ClickyNotice; detail?: string } | null;
  /** The model call in flight, so a late answer to a question nobody is waiting on is dropped. */
  thinkId: string | null;
  /** What the last model call was for, so Retry can ask again. */
  lastThink: { reason: ClickyThinkReason; text?: string } | null;
  /** When the person last made progress: a step done, a click on the target, an answer. */
  lastProgressAt: string;
  /** When the "stuck?" nudge was shown for the current step, so it is shown once. */
  nudgedAt: string | null;
  /** Actions run back to back without the person, so a task cannot loop forever. */
  autoSteps: number;
  /**
   * Showing what the Bot is doing on its computer rather than guiding the person: Clicky points at
   * each element the Bot acts on and says what it does. Only watches; never takes control.
   */
  narrating: boolean;
  /**
   * A look at the screen after the person (or Clicky) did something, to see whether the step is done
   * and where things are now. While it runs the overlays are `overlaysStale` and drawn dimmed.
   */
  check: { id: string; stepId: string | null } | null;
  overlaysStale: boolean;
  stoppedAt: string | null;
  /** Bumped on every change. A client that sees a gap refetches the snapshot. */
  seq: number;
  updatedAt: string;
};

/** Why Clicky looks at the screen and asks the model. */
export type ClickyThinkReason =
  | "ask"
  | "show_me"
  | "activate"
  | "do_it"
  | "retry"
  | "continue";

/**
 * Clicky's own fixed lines. The server sends the name; each client shows its own words, in its own
 * language. `CLICKY_NOTICE_TEXT` is the English, which is also the web app's translation key.
 */
export const CLICKY_NOTICES = [
  "awake",
  "takeover",
  "yours",
  "blocked",
  "denied",
  "stopped",
  "paused",
  "expired",
  "nudge",
  "walkthrough_done",
  "takeover_resolved",
  "action_done",
  "action_failed",
  "think_failed",
  "guide_only",
  "busy",
  "nothing_to_retry",
  "no_step",
  "follow_up",
  "notes_saved",
  "watching",
  "narrate_click",
  "narrate_type",
  "narrate_navigate",
  "narrate_scroll",
  "narrate_select",
  "narrate_key",
  "narrate_working",
  "narrate_choose",
  "narrate_click_here",
  "narrate_type_here",
] as const;
export type ClickyNotice = (typeof CLICKY_NOTICES)[number];

export const CLICKY_NOTICE_TEXT: Record<ClickyNotice, string> = {
  awake: "Hi! Ask me anything about the screen.",
  takeover: "Noë Bot needs you here.",
  yours: "This one's yours. I'll show you where.",
  blocked: "I can't do that one, but I'll show you where it is.",
  denied: "Okay, I won't. It's right here if you'd like to do it yourself.",
  stopped: "Stopped. Nothing else will happen until you say so.",
  paused: "Paused.",
  expired: "That request timed out. Ask again when you're ready.",
  nudge: "Stuck? Ask me anything, or tap Show me again.",
  walkthrough_done: "That's everything. Nice work.",
  takeover_resolved: "Thanks! Noë Bot is carrying on.",
  action_done: "Done.",
  action_failed: "That didn't work. Try again, or do it yourself.",
  think_failed: "I couldn't look at the screen just now. Try again.",
  guide_only: "I'm set to guide only. You can change that in Settings.",
  busy: "One moment, I'm still working on the last thing.",
  nothing_to_retry: "There's nothing to try again yet.",
  no_step: "There's no step to move to.",
  follow_up: "Noë Bot finished.",
  notes_saved: "Notes saved.",
  watching: "I'll show you what Noë Bot is doing.",
  narrate_click: "Noë Bot is clicking “{{label}}”.",
  narrate_type: "Noë Bot is typing in “{{label}}”.",
  narrate_navigate: "Noë Bot is opening {{host}}.",
  narrate_scroll: "Noë Bot is scrolling the page.",
  narrate_select: "Noë Bot is choosing in “{{label}}”.",
  narrate_key: "Noë Bot is pressing {{key}}.",
  narrate_working: "Noë Bot is working on the page.",
  // For a control the page gave no name: the option chosen, or "here" beside the pointer.
  narrate_choose: "Noë Bot is choosing “{{option}}”.",
  narrate_click_here: "Noë Bot is clicking here.",
  narrate_type_here: "Noë Bot is typing here.",
};

/** What a client may send: the web app's bar, the phone, and the bridge for overlays. */
export type ClickyCommand =
  | { type: "wake" }
  | { type: "sleep" }
  /** Hold to talk pressed (`true`) or released (`false`). The words arrive as `ask`. */
  | { type: "listen"; active: boolean }
  | { type: "ask"; text: string }
  /** Look again and point at the current step. */
  | { type: "show_me" }
  | { type: "next" }
  | { type: "back" }
  /** Say the last line again; clients read it aloud when speaking is on. */
  | { type: "repeat" }
  /**
   * `task` is what phones built before "Allow for this session" send for their "Allow for this task"
   * button. It is read as `once`: those phones promised less than a session, so it grants nothing more.
   */
  | { type: "approve"; proposalId: string; scope: "once" | "session" | "task" }
  | { type: "deny"; proposalId: string }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "retry" }
  | { type: "set_mode"; mode: ClickyMode }
  | { type: "activate"; trigger: ClickyTrigger }
  /** Show what the Bot is doing (the screen was opened while the Bot works). */
  | { type: "watch" }
  /** The bridge: draw these overlays (OpenClicky's `/cursor`, `/cursors`, `/caption`). */
  | { type: "overlay.set"; overlays: ClickyOverlay[] }
  | { type: "overlay.clear" }
  /** Write the session's notes to the Bot's workspace. */
  | { type: "save_notes" };

/** What the server sends on the events socket. */
export type ClickyServerEvent =
  | { type: "snapshot"; session: ClickySession }
  /**
   * Part of Clicky's reply while it is still arriving: the next piece of text, to append.
   *
   * `thinkId` is the model call it belongs to (`ClickySession.thinkId`), and is what a client keys
   * the words it is collecting by: `seq` can move while one call is still answering (Clicky's first
   * pointer on activation is a snapshot of its own), and a session started afresh counts from zero
   * again. Words for a call the client's session is no longer waiting on are dropped; the answer's
   * snapshot always carries the whole reply.
   */
  | { type: "reply.delta"; seq: number; thinkId: string; text: string }
  /** Something may have been missed: fetch the snapshot again. */
  | { type: "resync" };

/**
 * The reason Clicky's own request for control carries ("Do it for me" with nobody holding the
 * computer). The server compares it so its own handover never reopens Clicky, and screens that show a
 * handover's reason draw their own words for it, since every other reason is the Bot's.
 */
export const CLICKY_HELP_REASON = "Show me how is doing this for you";

export const CLICKY_TRANSCRIPT_LIMIT = 20;
export const CLICKY_TEXT_LIMIT = 2000;
export const CLICKY_OVERLAY_LIMIT = 12;
export const CLICKY_STEP_LIMIT = 20;
/** An unanswered proposal lapses after two minutes; the screen has likely moved on. */
export const CLICKY_PROPOSAL_TTL_MS = 2 * 60_000;
/** How long one "Allow for this session" lasts at most. */
export const CLICKY_SESSION_GRANT_TTL_MS = 2 * 60 * 60_000;
export const CLICKY_NUDGE_AFTER_MS = 45_000;
/** A session the person comes back to within this long resumes where it was. */
export const CLICKY_RESUME_WINDOW_MS = 30 * 60_000;
export const CLICKY_AUTO_STEP_LIMIT = 12;
/** How close to a point a click counts as "on it", normalized. */
export const CLICKY_TARGET_RADIUS = 0.03;

/** The step being worked on, if any. */
export function currentStep(session: ClickySession): ClickyStep | null {
  const walkthrough = session.walkthrough;
  if (!walkthrough?.currentStepId) return null;
  return (
    walkthrough.steps.find((step) => step.id === walkthrough.currentStepId) ??
    null
  );
}

/** Everything to draw now: the free overlays, then the current step's. */
export function visibleOverlays(session: ClickySession): ClickyOverlay[] {
  return [...session.overlays, ...(currentStep(session)?.overlays ?? [])];
}

/** Whether a normalized point falls on an overlay's target (inside a box, or near a point). */
export function hitsOverlay(
  point: ClickyPoint,
  overlay: ClickyOverlay,
): boolean {
  if (overlay.kind === "highlight") {
    const { rect } = overlay;
    return (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    );
  }
  if (overlay.kind === "caption") return false;
  return (
    Math.hypot(point.x - overlay.at.x, point.y - overlay.at.y) <=
    CLICKY_TARGET_RADIUS
  );
}

/** A value kept inside 0–1. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A fresh, asleep session for a Bot's computer. */
export function newClickySession(input: {
  id: string;
  botId: string;
  now: number;
}): ClickySession {
  const at = new Date(input.now).toISOString();
  return {
    id: input.id,
    botId: input.botId,
    state: "idle",
    resumeState: null,
    mode: "guide",
    awake: false,
    trigger: null,
    walkthrough: null,
    overlays: [],
    proposal: null,
    reply: null,
    transcript: [],
    grant: null,
    error: null,
    thinkId: null,
    lastThink: null,
    lastProgressAt: at,
    nudgedAt: null,
    autoSteps: 0,
    narrating: false,
    check: null,
    overlaysStale: false,
    stoppedAt: null,
    seq: 0,
    updatedAt: at,
  };
}

/**
 * A session as read back from storage, brought up to this version of the protocol: fields added
 * since it was written get their defaults, and a grant from before "Allow for this session" (one tied
 * to a walkthrough) is dropped rather than widened, so the person is simply asked again.
 */
export function normalizeClickySession(session: ClickySession): ClickySession {
  const stored = session as Partial<ClickySession> & ClickySession;
  const grant =
    stored.grant && (stored.grant as { scope?: unknown }).scope === "session"
      ? stored.grant
      : null;
  return {
    ...stored,
    grant,
    narrating: stored.narrating ?? false,
    check: stored.check ?? null,
    overlaysStale: stored.overlaysStale ?? false,
  };
}
