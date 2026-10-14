import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";
import { i18n, msg } from "@/lib/i18n";
import type {
  ClickyCommand,
  ClickyNotice,
  ClickySession,
} from "../../../../shared/clicky";
import { clickyKeys, newerSession } from "./queries";

const FALLBACK = msg("Clicky could not do that just now");

export type ClickyCommandResult = {
  session: ClickySession;
  /** Why the server refused the command, as one of Clicky's fixed lines. */
  rejected?: ClickyNotice;
};

const commandsPath = (botId: string) =>
  `/api/computers/${encodeURIComponent(botId)}/clicky/commands`;

/**
 * One command to a Bot's Clicky session, answered with the session as it is now.
 *
 * A plain function as well as the mutation below, for the callers that are not a press on a button:
 * the attention hook's fallback `activate`, the Stop shortcut and the stop pill, which may act on a
 * Bot no component on screen holds a mutation for.
 */
export async function sendClickyCommand(
  botId: string,
  command: ClickyCommand,
): Promise<ClickyCommandResult> {
  const body = (await (
    await client(commandsPath(botId), {
      method: "POST",
      body: command,
      fallback: FALLBACK,
    })
  ).json()) as { session?: ClickySession; rejected?: ClickyNotice };
  if (!body.session) throw new Error(i18n.t(FALLBACK));
  return {
    session: body.session,
    ...(body.rejected ? { rejected: body.rejected } : {}),
  };
}

/** Keeps the session the server answered with, unless the events socket already has a newer one. */
export function keepClickySession(
  queryClient: QueryClient,
  botId: string,
  session: ClickySession,
): void {
  queryClient.setQueryData<ClickySession>(clickyKeys.session(botId), (held) =>
    newerSession(held, session),
  );
}

/**
 * A command from Clicky's bar, cards and launcher.
 *
 * The answer is written into the cache rather than invalidated, against the usual rule, because it
 * IS the server's decision: the whole session, as the server's own reducer left it, with a `seq`
 * that orders it against what the events socket delivers. Refetching would only race the socket.
 */
export function clickyCommandMutationOptions(
  queryClient: QueryClient,
  botId: string,
) {
  return mutationOptions({
    mutationFn: (command: ClickyCommand): Promise<ClickyCommandResult> =>
      sendClickyCommand(botId, command),
    onSuccess: (result) =>
      keepClickySession(queryClient, botId, result.session),
  });
}

/** Signs a linked phone out: its session ends and it disappears from the list. */
export function revokeMobileDeviceMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (deviceId: string): Promise<void> => {
      await client(`/api/mobile/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
        fallback: "Could not sign that phone out",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: clickyKeys.devices() }),
  });
}

/** What `computer_guide_person` sends: a goal and up to eight steps, each with an element's ref. */
export type ClickyGuideInput = {
  goal: string;
  steps: { say: string; ref?: string }[];
};

/**
 * The Bot's walkthrough for the person, drawn by Clicky on their view of its screen.
 *
 * A tool call during a turn, so it fails closed with a reason the model reads (English, never
 * translated) rather than throwing: a deployment without Clicky, or one that refused the steps, is
 * an answer for the Bot to work with.
 */
export async function postClickyGuide(
  botId: string,
  input: ClickyGuideInput,
  signal?: AbortSignal,
): Promise<{ ok: true; shown: string } | { ok: false; reason: string }> {
  try {
    const response = await tryClient(
      `/api/computers/${encodeURIComponent(botId)}/clicky/guide`,
      { method: "POST", body: input, ...(signal ? { signal } : {}) },
    );
    if (response.ok) {
      /*
       * Answered, but not necessarily drawn: the session's reducer can refuse the walkthrough (busy,
       * guide-only…) and says so as `rejected` beside the unchanged session.
       */
      const answer = (await response.json().catch(() => null)) as {
        rejected?: unknown;
      } | null;
      if (answer?.rejected)
        return {
          ok: false,
          reason:
            "Clicky could not show this right now; describe the steps in words.",
        };
      return {
        ok: true,
        shown:
          "Clicky is now pointing at each step on the person's view of your screen. Tell them in one short line what to do; they may follow it or ignore it.",
      };
    }
    if (response.status === 404)
      return {
        ok: false,
        reason:
          "Clicky is not available on this deployment. Describe the steps to the person in words instead.",
      };
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    return {
      ok: false,
      reason:
        typeof body?.error === "string"
          ? body.error
          : "Clicky could not show those steps. Describe them to the person in words instead.",
    };
  } catch {
    return {
      ok: false,
      reason:
        "Clicky could not be reached. Describe the steps to the person in words instead.",
    };
  }
}
