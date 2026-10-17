import { tryClient } from "@/lib/client";

/**
 * Handing control of a Bot's computer to a person, and back.
 *
 * Plain functions rather than factories, and every one of them fails closed. Nothing here is cached:
 * who holds the wheel is a fact about this second, and a stale copy of it would be worse than no
 * copy — it would show somebody a screen they cannot drive, or let them think they can.
 *
 * The reads answer `null` on failure rather than throwing. A panel that cannot say who is driving
 * should say nothing, not tear down the screen the person is looking at.
 */

export type { ComputerControlState as ControlState } from "../../../../shared/computer-control";

import { i18n } from "@/lib/i18n";
import type {
  ComputerControlState as ControlState,
  HandoffSource,
} from "../../../../shared/computer-control";

async function callControl(
  computerId: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<ControlState | null> {
  const response = await tryClient(
    `/api/computers/${encodeURIComponent(computerId)}${path}`,
    { ...(body === undefined ? {} : { method: "POST", body }), signal },
  );
  if (!response.ok) return null;
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || !("holder" in value)) return null;
  if (value.holder !== "bot" && value.holder !== "human") return null;
  return value as ControlState;
}

export function readControl(
  computerId: string,
  requestId?: string,
  signal?: AbortSignal,
) {
  return callControl(
    computerId,
    `/control${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`,
    undefined,
    signal,
  );
}

/**
 * Why control is being taken, for the request a take makes when the Bot has not asked for anybody.
 *
 * - `reason`: what the request says. A person's own press says nothing of its own; "Show me how"
 *   taking control to guide the person says `CLICKY_HELP_REASON`, which the server knows as its own.
 * - `source`: `manual` for a person's own Take control (the button, Record your steps, a chat
 *   card's Take over), so the server never mistakes it for the Bot asking for help and opens "Show
 *   me how" over it. A server that predates it ignores the field.
 */
export type TakeControlOptions = { reason?: string; source?: HandoffSource };

/**
 * What a person's own Take control says, for the server and the trail. It is not shown back to
 * them: the line is theirs, in English, and tells them nothing (`handoverReason` in the viewer).
 */
export const MANUAL_TAKE_REASON = "I want to take control of the browser.";

export async function takeControl(
  computerId: string,
  requestId?: string,
  options: TakeControlOptions = {},
) {
  const id =
    requestId ??
    (
      await callControl(computerId, "/control/request", {
        reason: options.reason ?? MANUAL_TAKE_REASON,
        ...(options.source ? { source: options.source } : {}),
      })
    )?.request?.id;
  return id
    ? callControl(computerId, "/control/take", { requestId: id })
    : null;
}

export function releaseControl(computerId: string, requestId: string) {
  return callControl(computerId, "/control/release", { requestId });
}

export function cancelControl(computerId: string, requestId: string) {
  return callControl(computerId, "/control/cancel", { requestId });
}

/**
 * Supply a secret synchronously and never echo the value back to the UI.
 *
 * The one call here that reports why it failed, because a person is waiting on the answer and a
 * silent failure would leave them typing into something that is not listening.
 */
/** The person declining the value the Bot asked for: the Bot is told it was cancelled. */
export async function declineSecret(
  computerId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/human/secret/cancel`,
      { method: "POST", body: {} },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return {
      ok: false,
      error: body?.error ?? i18n.t("That could not be declined."),
    };
  } catch {
    return {
      ok: false,
      error: i18n.t("The assistant's computer could not be reached."),
    };
  }
}

export async function supplySecret(
  computerId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await tryClient(
      `/api/computers/${computerId}/human/secret`,
      { method: "POST", body: { text } },
    );
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return {
      ok: false,
      error: body?.error ?? i18n.t("That could not be entered."),
    };
  } catch {
    return {
      ok: false,
      error: i18n.t("The assistant's computer could not be reached."),
    };
  }
}

/**
 * Serializes human input requests without blocking the caller; ordering matters for typed secrets.
 */
let inputQueue: Promise<unknown> = Promise.resolve();

/**
 * Send one human input event. Returns immediately; delivery is ordered.
 */
export function sendHumanInput(
  computerId: string,
  kind: "click" | "type" | "key" | "scroll",
  body: Record<string, unknown>,
): void {
  inputQueue = inputQueue
    .then(() =>
      tryClient(`/api/computers/${computerId}/human/${kind}`, {
        method: "POST",
        body,
      }),
    )
    // Fire-and-forget: the user can see/retry input failures, while the input queue must keep moving.
    .catch(() => undefined);
}
