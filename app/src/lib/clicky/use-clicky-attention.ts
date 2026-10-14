import { useEffect, useRef } from "react";
import { queryClient } from "@/query-client";
import type { ClickySession, ClickyTrigger } from "../../../../shared/clicky";
import type { ComputerControlState } from "../../../../shared/computer-control";
import { keepClickySession, sendClickyCommand } from "./mutations";
import {
  clickySessionQueryOptions,
  useClickyCapability,
  useClickyPreferences,
} from "./queries";
import { requestClickyViewer } from "./viewer-request";

/**
 * How long the browser leaves the server to open Clicky itself before it sends its own `activate`.
 * The server hears the handover the moment it happens; this tab only on its next control poll.
 */
export const CLICKY_ACTIVATE_GRACE_MS = 1_500;

/**
 * What the Bot needs from the person on its computer, as Clicky's trigger, read from the
 * computer's control state: a secret typed into a field, a challenge the browser hit, or a
 * takeover the Bot asked for. Null when it needs nothing.
 *
 * The request ids are the server's own, so the reducer counts this tab's `activate` and the
 * server's as the same one: the handover request's id, and `secret:<ref>:<snapshot>` for a secret
 * (how the server's activation names it). Sign-ins are not here: they are answered in the private
 * sign-in form, not on the screen, and the server opens Clicky for them itself.
 */
export function clickyNeedOf(
  control: ComputerControlState | null | undefined,
): ClickyTrigger | null {
  if (!control) return null;
  if (control.secretWanted !== undefined) {
    const ref = control.secretRef;
    // Spelled exactly as the server's activation spells it, empty parts and all.
    return {
      kind: "secret",
      requestId: `secret:${ref ?? ""}:${control.secretSnapshotId ?? ""}`,
      ...(ref ? { targetRef: ref } : {}),
    };
  }
  if (control.requested && control.request) {
    const request = control.request;
    const challenge =
      request.source === "cloudflare" || request.source === "visible-challenge";
    // Trimmed and capped as the server's activation does, so both say the same thing.
    const reason = (control.reason ?? request.reason)?.trim().slice(0, 500);
    // The element the Bot asked the person to use (`point_at`), when the server kept it.
    const pointAt = (request as { pointAt?: unknown }).pointAt;
    return {
      kind: challenge ? "challenge" : "takeover",
      requestId: request.id,
      ...(reason ? { reason } : {}),
      ...(typeof pointAt === "string" && pointAt ? { targetRef: pointAt } : {}),
    };
  }
  return null;
}

/**
 * Whether the session is already open for this need, so the fallback `activate` would only repeat
 * what the server did: awake, on a trigger from the Bot (not a person's question or a follow-up) of
 * the same kind, and for the same request when both sides name one.
 */
export function clickyActivatedFor(
  session: ClickySession | undefined,
  need: ClickyTrigger,
): boolean {
  const trigger = session?.trigger;
  if (!session?.awake || !trigger) return false;
  if (trigger.kind === "person" || trigger.kind === "follow_up") return false;
  if (need.requestId && trigger.requestId)
    return need.requestId === trigger.requestId;
  return trigger.kind === need.kind;
}

/**
 * When the Bot needs the person on its computer and they let Clicky open by itself
 * (`clickyAutoActivate`): ask for the Bot's screen to open full-window, and make sure Clicky is
 * awake on it.
 *
 * THE SERVER OPENS CLICKY ITSELF, from the same handover events; this is the person's side of it
 * (the screen in front of them) and a fallback that does not race it. The screen is asked for at
 * once; the session is read again after a grace period, and `activate` is sent only if Clicky is
 * still not awake on this need, with the server's own ids. Once per need: the same request seen on
 * every poll asks nothing again, and a need that clears and comes back is a new one.
 */
export function useClickyAttention(
  botId: string | undefined,
  control: ComputerControlState | null | undefined,
  graceMs = CLICKY_ACTIVATE_GRACE_MS,
): void {
  const { enabled } = useClickyCapability();
  const preferences = useClickyPreferences();
  const need = clickyNeedOf(control);
  const needKey =
    botId && need
      ? `${botId}:${need.kind}:${need.requestId ?? control?.secretWanted ?? ""}`
      : null;
  const handled = useRef<string | null>(null);
  const latestNeed = useRef(need);
  latestNeed.current = need;

  const ready = enabled && preferences.loaded && preferences.clickyAutoActivate;

  useEffect(() => {
    if (!needKey) {
      handled.current = null;
      return;
    }
    if (!ready || !botId || handled.current === needKey) return;
    handled.current = needKey;
    const wanted = latestNeed.current;
    if (!wanted) return;
    requestClickyViewer(botId);
    let current = true;
    let fired = false;
    const timer = setTimeout(async () => {
      fired = true;
      try {
        const session = await queryClient.fetchQuery({
          ...clickySessionQueryOptions(botId),
          staleTime: 0,
        });
        if (!current || clickyActivatedFor(session, wanted)) return;
        const result = await sendClickyCommand(botId, {
          type: "activate",
          trigger: wanted,
        });
        keepClickySession(queryClient, botId, result.session);
      } catch {
        // The server opens Clicky for this too; a fallback that fails costs nothing but itself.
      }
    }, graceMs);
    return () => {
      // Interrupted before the grace ran out: the need went away (nothing to fall back on), or the
      // effect is starting again for the same need, which then counts as not yet handled.
      current = false;
      clearTimeout(timer);
      if (!fired && handled.current === needKey) handled.current = null;
    };
  }, [ready, botId, needKey, graceMs]);
}
