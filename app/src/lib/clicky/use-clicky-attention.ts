import { useEffect, useRef } from "react";
import { queryClient } from "@/query-client";
import type { ComputerControlState } from "../../../../shared/computer-control";
import type { ClickySession, ClickyTrigger } from "../../../../shared/clicky";
import { sendClickyCommand, keepClickySession } from "./mutations";
import {
  clickySessionQueryOptions,
  useClickyCapability,
  useClickyPreferences,
} from "./queries";
import { requestClickyViewer } from "./viewer-request";

/**
 * What the Bot needs from the person on its computer, as Clicky's trigger, read from the
 * computer's control state: a secret typed into a field, a challenge the browser hit, or a
 * takeover the Bot asked for. Null when it needs nothing.
 *
 * Sign-ins are not here: they are answered in the private sign-in form, not on the screen, and the
 * server opens Clicky for them itself.
 */
export function clickyNeedOf(
  control: ComputerControlState | null | undefined,
): ClickyTrigger | null {
  if (!control) return null;
  // A secret has no request of its own on the control state; the field it goes in is the target.
  if (control.secretWanted !== undefined)
    return {
      kind: "secret",
      ...(control.secretRef ? { targetRef: control.secretRef } : {}),
    };
  if (control.requested && control.request) {
    const challenge =
      control.request.source === "cloudflare" ||
      control.request.source === "visible-challenge";
    const reason = control.reason ?? control.request.reason;
    return {
      kind: challenge ? "challenge" : "takeover",
      requestId: control.request.id,
      ...(reason ? { reason } : {}),
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
  if (need.kind === "secret") return trigger.kind === "secret";
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
 * (the screen in front of them) and a fallback. It reads the session fresh and sends `activate` only
 * when the server has not, with the request's own id, so the server's reducer treats any later copy
 * of the same activation as the same one. Once per need: the same request seen on every poll asks
 * nothing again.
 */
export function useClickyAttention(
  botId: string | undefined,
  control: ComputerControlState | null | undefined,
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
    if (!ready || !botId || !needKey) return;
    if (handled.current === needKey) return;
    handled.current = needKey;
    const wanted = latestNeed.current;
    if (!wanted) return;
    requestClickyViewer(botId);
    void (async () => {
      try {
        const session = await queryClient.fetchQuery({
          ...clickySessionQueryOptions(botId),
          staleTime: 0,
        });
        if (clickyActivatedFor(session, wanted)) return;
        const result = await sendClickyCommand(botId, {
          type: "activate",
          trigger: wanted,
        });
        keepClickySession(queryClient, botId, result.session);
      } catch {
        // The server opens Clicky for this too; a fallback that fails costs nothing but itself.
      }
    })();
  }, [ready, botId, needKey]);
}
