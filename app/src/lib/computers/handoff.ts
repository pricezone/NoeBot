import { tryClient } from "@/lib/client";
import type {
  BrowserChallenge,
  HandoffRequest,
} from "../../../../shared/computer-control";
import { callComputer, type ToolOutcome } from "./call";
import { cancelControl, readControl } from "./control";

export type PendingHandoff = { requestId: string; toolCallId: string };
const active = new Map<string, number>();
const key = (botId: string) => `openbot:pending-handoff:${botId}`;

/** Bookkeeping only. Never persist page text, credentials, or the human's input. */
export function pendingHandoff(botId: string): PendingHandoff | null {
  if (typeof sessionStorage === "undefined") return null;
  const text = sessionStorage.getItem(key(botId));
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value &&
      typeof value === "object" &&
      "requestId" in value &&
      typeof value.requestId === "string" &&
      "toolCallId" in value &&
      typeof value.toolCallId === "string"
      ? { requestId: value.requestId, toolCallId: value.toolCallId }
      : null;
  } catch {
    return null;
  }
}
export function rememberHandoff(
  botId: string,
  requestId: string,
  toolCallId?: string,
) {
  if (toolCallId && typeof sessionStorage !== "undefined")
    sessionStorage.setItem(
      key(botId),
      JSON.stringify({ requestId, toolCallId }),
    );
}
export function forgetHandoff(botId: string, requestId: string) {
  if (pendingHandoff(botId)?.requestId === requestId)
    sessionStorage.removeItem(key(botId));
}
export function hasActiveHandoff(botId: string, requestId: string) {
  return (active.get(`${botId}:${requestId}`) ?? 0) > 0;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * What a Bot is told when nobody took the wheel before the request lapsed.
 *
 * In words it acts on, because the bare status was read as "try again": in the gov.gr run a Bot
 * whose person had stepped away asked for a takeover every ten minutes for as long as its tab stayed
 * open (O13). Nobody is watching a request that lapsed, so another one reaches nobody either.
 */
export const NOBODY_TOOK_OVER =
  "Nobody took over before this request lapsed: the person is not at the screen. Do not ask again now. Say in one or two sentences what you need them to do and where you stopped, then end your turn. They will answer when they are back.";

/** No human-control deadline: waiting expiry and all terminal outcomes belong to the server. */
export async function awaitHandoff(
  botId: string,
  requestId: string,
  signal?: AbortSignal,
  pollMs = 1000,
): Promise<ToolOutcome> {
  const identity = `${botId}:${requestId}`;
  active.set(identity, (active.get(identity) ?? 0) + 1);
  let lastRequest: HandoffRequest | undefined;
  let failures = 0;
  try {
    while (!signal?.aborted) {
      const state = await readControl(botId, requestId, signal).catch(
        () => null,
      );
      if (signal?.aborted) break;
      if (!state) {
        if (++failures >= 5)
          return {
            ok: false,
            requestId,
            reconnecting: true,
            reason:
              "The handoff could not be reached. Reopen this conversation and use Resume task to check this request again.",
          };
        await pause(pollMs, signal);
        continue;
      }
      failures = 0;
      if (state.request?.id !== requestId)
        return {
          ok: false,
          requestId,
          reason:
            "The computer did not return the requested handoff. Nothing has been marked complete.",
        };
      lastRequest = state.request;
      if (lastRequest.status === "completed") {
        const snapshot = await callComputer(
          botId,
          "/snapshot",
          { method: "POST" },
          signal,
        );
        if (!snapshot.ok)
          return {
            ...snapshot,
            requestId,
            handoffStatus: "completed",
            snapshotRequired: true,
          };
        const nextChallenge = challengeFrom(snapshot);
        if (nextChallenge) {
          if (nextChallenge.requestId === requestId)
            return {
              ok: false,
              requestId,
              reason:
                "The completed request still reports an active challenge. Check the browser before continuing.",
            };
          rememberHandoff(
            botId,
            nextChallenge.requestId,
            pendingHandoff(botId)?.toolCallId,
          );
          const next = await awaitHandoff(
            botId,
            nextChallenge.requestId,
            signal,
            pollMs,
          );
          return { ...next, challenge: nextChallenge };
        }
        return {
          ...snapshot,
          requestId,
          handoffStatus: "completed",
          result:
            "The person handed control back. This fresh snapshot describes the page now.",
        };
      }
      if (lastRequest.status !== "waiting" && lastRequest.status !== "taken") {
        return {
          ok: false,
          requestId,
          handoffStatus: lastRequest.status,
          reason:
            lastRequest.interruption ??
            (lastRequest.status === "expired"
              ? NOBODY_TOOK_OVER
              : `The handoff was ${lastRequest.status}. The person has not completed this request.`),
        };
      }
      await pause(pollMs, signal);
    }
    // Stop detaches a driver. Only a still-waiting request may be cancelled.
    if (signal?.reason === "detached")
      return {
        ok: false,
        stopped: true,
        requestId,
        reason: "The waiting view disconnected.",
      };
    const current = await readControl(
      botId,
      requestId,
      AbortSignal.timeout(2000),
    ).catch(() => null);
    if (
      current?.request?.id === requestId &&
      current.request.status === "waiting"
    )
      await cancelControl(botId, requestId).catch(() => null);
    return {
      ok: false,
      stopped: true,
      requestId,
      reason:
        "Stopped waiting. A person who has control keeps it until they hand back.",
    };
  } finally {
    const remaining = (active.get(identity) ?? 1) - 1;
    if (remaining) active.set(identity, remaining);
    else active.delete(identity);
  }
}

function requestFrom(result: ToolOutcome): HandoffRequest | undefined {
  const request = result.request;
  return request &&
    typeof request === "object" &&
    "id" in request &&
    typeof request.id === "string"
    ? (request as HandoffRequest)
    : undefined;
}

/**
 * `pointAt` is the element the person should use first (`point_at` on the tool), so Clicky can point
 * at it while they help. A server that predates Clicky ignores it.
 */
export async function runHelpRequest(
  botId: string,
  reason: string,
  toolCallId?: string,
  signal?: AbortSignal,
  pointAt?: string,
): Promise<ToolOutcome> {
  const stored = pendingHandoff(botId);
  if (toolCallId && stored?.toolCallId === toolCallId)
    return awaitHandoff(botId, stored.requestId, signal);
  const asked = await callComputer(
    botId,
    "/control/request",
    {
      method: "POST",
      body: {
        reason,
        ...(toolCallId ? { toolCallId } : {}),
        ...(pointAt?.trim() ? { pointAt: pointAt.trim() } : {}),
      },
    },
    signal,
  );
  if (!asked.ok) return asked;
  const request = requestFrom(asked);
  if (!request)
    return {
      ok: false,
      reason: "The computer did not identify the handoff request.",
    };
  rememberHandoff(botId, request.id, toolCallId);
  return awaitHandoff(botId, request.id, signal);
}

export async function runNavigation(
  botId: string,
  url: string,
  toolCallId?: string,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const stored = pendingHandoff(botId);
  if (toolCallId && stored?.toolCallId === toolCallId)
    return awaitHandoff(botId, stored.requestId, signal);
  const result = await callComputer(
    botId,
    "/navigate",
    { method: "POST", body: { url, ...(toolCallId ? { toolCallId } : {}) } },
    signal,
  );
  const challenge = challengeFrom(result);
  if (!challenge?.requestId) return result;
  rememberHandoff(botId, challenge.requestId, toolCallId);
  const resumed = await awaitHandoff(botId, challenge.requestId, signal);
  // Only the resumed snapshot describes the current page. The initial response belongs to
  // the challenge page and may carry text/truncation fields absent from a snapshot.
  return { ...resumed, challenge, challengeResolved: resumed.ok };
}

function challengeFrom(result: ToolOutcome): BrowserChallenge | undefined {
  const value = result.challenge;
  if (
    !value ||
    typeof value !== "object" ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("kind" in value) ||
    (value.kind !== "cloudflare" && value.kind !== "visible-challenge") ||
    !("reason" in value) ||
    typeof value.reason !== "string"
  )
    return undefined;
  return { requestId: value.requestId, kind: value.kind, reason: value.reason };
}

export async function runBrowserRead(
  botId: string,
  path: "/read" | "/snapshot",
  toolCallId?: string,
  signal?: AbortSignal,
  /** For a read: the words to wait for on the page, and for how long. */
  wait?: { waitFor?: string; timeoutSeconds?: number },
): Promise<ToolOutcome> {
  const stored = pendingHandoff(botId);
  if (toolCallId && stored?.toolCallId === toolCallId)
    return awaitHandoff(botId, stored.requestId, signal);
  const query = new URLSearchParams();
  if (path === "/read" && wait?.waitFor?.trim()) {
    query.set("waitFor", wait.waitFor.trim());
    if (wait.timeoutSeconds)
      query.set("timeoutSeconds", String(wait.timeoutSeconds));
  }
  const result = await callComputer(
    botId,
    query.size ? `${path}?${query}` : path,
    path === "/snapshot" ? { method: "POST" } : undefined,
    signal,
  );
  const challenge = challengeFrom(result);
  if (!challenge) return result;
  rememberHandoff(botId, challenge.requestId, toolCallId);
  const resumed = await awaitHandoff(botId, challenge.requestId, signal);
  return { ...resumed, challenge, challengeResolved: resumed.ok };
}

/**
 * A computer call the server carried out inside the run that stopped to wait for the person
 * (COMPUTER_TOOLS_IN_RUN): a sign-in, a takeover, a secret, an approval. See server/src/runs/waits.ts.
 *
 * `ready` means the person has answered and the run can continue; `claimed` means somebody already
 * continued it (the server, another tab) or the person stopped it.
 */
export type ServerWait = {
  kind: string;
  requestId: string | null;
  status: "waiting" | "ready" | "claimed";
  claimedBy?: string;
};

const waitPath = (threadId: string, toolCallId: string) =>
  `/api/runs/waits/${encodeURIComponent(threadId)}/${encodeURIComponent(toolCallId)}`;

/** The server's wait for this call, or null when the server did not carry the call out. */
export async function readServerWait(
  threadId: string,
  toolCallId: string,
  signal?: AbortSignal,
): Promise<ServerWait | null> {
  const response = await tryClient(waitPath(threadId, toolCallId), { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("The paused task could not be checked.");
  const body = (await response.json()) as Partial<ServerWait>;
  return typeof body.kind === "string" &&
    (body.status === "waiting" ||
      body.status === "ready" ||
      body.status === "claimed")
    ? {
        kind: body.kind,
        requestId: typeof body.requestId === "string" ? body.requestId : null,
        status: body.status,
        ...(typeof body.claimedBy === "string"
          ? { claimedBy: body.claimedBy }
          : {}),
      }
    : null;
}

/**
 * Take the answered wait so this tab continues the run. The content is the tool result the server
 * built from the request itself; null when somebody else continued it first.
 */
export async function claimServerWait(
  threadId: string,
  toolCallId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const response = await tryClient(`${waitPath(threadId, toolCallId)}/claim`, {
    method: "POST",
    body: {},
    signal,
  });
  if (!response.ok) return null;
  const body = (await response.json()) as {
    claimed?: boolean;
    content?: unknown;
  };
  return body.claimed === true && typeof body.content === "string"
    ? body.content
    : null;
}

/** The person stopped the turn: nobody, the server included, may continue it. */
export async function stopServerWait(
  threadId: string,
  toolCallId: string,
): Promise<void> {
  await tryClient(`${waitPath(threadId, toolCallId)}/claim`, {
    method: "POST",
    body: { stop: true },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}

/**
 * Wait for the person to answer a server wait, as long as the server keeps it open.
 *
 * `ready`: answered, claim it. `claimed`: continued elsewhere. `gone`: the server no longer has it.
 * `stopped`: this wait was aborted. A few unreadable answers in a row are tolerated, like a takeover.
 */
export async function awaitServerWait(
  threadId: string,
  toolCallId: string,
  signal?: AbortSignal,
  pollMs = 1000,
): Promise<"ready" | "claimed" | "gone" | "stopped"> {
  let failures = 0;
  while (!signal?.aborted) {
    const wait = await readServerWait(threadId, toolCallId, signal).catch(
      () => undefined,
    );
    if (signal?.aborted) break;
    if (wait === null) return "gone";
    if (wait === undefined) {
      if (++failures >= 30) return "gone";
    } else {
      failures = 0;
      if (wait.status !== "waiting") return wait.status;
    }
    await pause(pollMs, signal);
  }
  return "stopped";
}
