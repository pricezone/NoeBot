import { useSyncExternalStore } from "react";
import { setChannelBusy } from "./mutations";

/**
 * The moments of a turn, from the tab running it to the person's other tabs.
 *
 * A tab watching a conversation somebody else's tab is running joins the run once, when it opens,
 * and read the history again only when the roster reported a new Bot message. A turn that stops to
 * wait on the person — a Secure Form, a question card — reports nothing until it is over, so the card
 * the person was waiting for appeared in their other tab only after a reload. Re-joining the run is
 * not the answer: joining runs any frontend tool still pending in the joining tab.
 *
 * So the running tab says each moment — a run starting, a run ending, a card starting to wait — as a
 * step on its busy signal, and every other tab reads the conversation again when the step changes.
 * A step is a number the sending tab only raises (milliseconds, so a reloaded tab does not start
 * again from one), and a tab ignores the steps it sent itself.
 */

/** What kind of card is waiting on the person. Mirrors the server's `CHANNEL_WAITING_KINDS`. */
export type WaitingKind =
  | "sign_in"
  | "secret"
  | "help"
  | "choice"
  | "approval"
  | "question";

export type ChannelWaiting = { kind: WaitingKind; toolCallId: string };

export type ChannelStep = {
  step: number;
  busy: boolean;
  waiting?: ChannelWaiting;
};

/** The tools whose call waits on the person, and the card each one draws. */
export const WAITING_TOOLS: Readonly<Record<string, WaitingKind>> = {
  computer_request_sign_in: "sign_in",
  computer_request_secret: "secret",
  computer_request_help: "help",
  askChoice: "choice",
  askApproval: "approval",
  ask_person: "question",
};

const WAITING_KINDS = new Set<string>(Object.values(WAITING_TOOLS));

/** A waiting card read off the wire, or nothing when the payload does not describe one. */
export function readWaiting(value: unknown): ChannelWaiting | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, toolCallId } = value as Record<string, unknown>;
  return typeof kind === "string" &&
    WAITING_KINDS.has(kind) &&
    typeof toolCallId === "string" &&
    toolCallId
    ? { kind: kind as WaitingKind, toolCallId }
    : undefined;
}

const latest = new Map<string, ChannelStep>();
/** Steps this tab sent, so its own signals coming back over the socket are not news to it. */
const sentHere = new Set<number>();
const SENT_KEPT = 200;
const listeners = new Set<() => void>();
let lastStep = 0;

/** The next step: higher than every step this tab sent, and than the clock. */
export function nextStep(): number {
  lastStep = Math.max(lastStep + 1, Date.now());
  return lastStep;
}

/**
 * Say a moment of this tab's turn. Fire-and-forget, like the busy signal it rides on: a step that
 * does not arrive costs a watching tab its quick refresh, and its own polling still catches up.
 */
export function reportStep(
  channelId: string,
  busy: boolean,
  waiting?: ChannelWaiting,
  /** The turn starting or ending: the channel's other members are told it is (no longer) busy. */
  announce = false,
): number {
  const step = nextStep();
  sentHere.add(step);
  if (sentHere.size > SENT_KEPT) {
    const oldest = sentHere.values().next().value;
    if (oldest !== undefined) sentHere.delete(oldest);
  }
  void setChannelBusy({
    channelId,
    busy,
    step,
    ...(waiting ? { waiting } : {}),
    ...(announce ? { announce } : {}),
  });
  return step;
}

/** A step heard over the socket. Ignored when this tab sent it or it is the one already held. */
export function noteChannelStep(channelId: string, step: ChannelStep): void {
  if (sentHere.has(step.step)) return;
  if (latest.get(channelId)?.step === step.step) return;
  latest.set(channelId, step);
  for (const listener of listeners) listener();
}

export function channelStep(channelId: string): ChannelStep | undefined {
  return latest.get(channelId);
}

export function subscribeToChannelSteps(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest step another tab reported in this conversation, re-rendering when it changes. */
export function useChannelStep(channelId: string): ChannelStep | undefined {
  return useSyncExternalStore(
    subscribeToChannelSteps,
    () => latest.get(channelId),
    () => undefined,
  );
}
