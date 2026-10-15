import {
  queryOptions,
  replaceEqualDeep,
  useQuery,
} from "@tanstack/react-query";
import { client, httpStatusOf } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import { queryClient } from "@/query-client";
import type { ClickySession } from "../../../../shared/clicky";
import type { MobileDevice } from "../../../../shared/mobile-link";
import {
  type ClickyPreferences,
  clickyPreferencesOf,
} from "../../../../shared/user-preferences";

/**
 * Clicky Mode, as the browser reads it: one session per person and Bot, kept on the server, and the
 * phones linked to this person's account.
 *
 * The session is the server's (`shared/clicky-state.ts` moves it); the browser only ever shows the
 * newest copy it has seen. Every change bumps `seq`, so "newest" is a number, and a copy that arrives
 * late (a slow GET racing the events socket) never replaces a newer one: `newerSession` decides it,
 * and the session query's `structuralSharing` asks it on every write to the cache.
 */

export const clickyKeys = {
  all: ["clicky"] as const,
  session: (botId: string) => ["clicky", "session", botId] as const,
  devices: () => ["clicky", "devices"] as const,
};

/**
 * The copy to keep: the one with the higher `seq`, and the incoming one on a tie (the same change,
 * answered twice: by the command's POST and by the events socket).
 *
 * Only snapshots are compared here. The words of an answer still arriving are not part of the
 * session in this cache (`use-clicky-session.ts` keeps them apart), so a copy taken before them never
 * wipes them.
 */
export function newerSession(
  held: ClickySession | undefined,
  incoming: ClickySession,
): ClickySession {
  if (!held || held.id !== incoming.id) return incoming;
  return incoming.seq < held.seq ? held : incoming;
}

function isSession(value: unknown): value is ClickySession {
  return (
    typeof value === "object" &&
    value !== null &&
    "seq" in value &&
    typeof value.seq === "number" &&
    "state" in value &&
    typeof value.state === "string"
  );
}

/** This person's Clicky session on a Bot's computer. Asleep until somebody wakes it. */
export function clickySessionQueryOptions(botId: string) {
  return queryOptions({
    queryKey: clickyKeys.session(botId),
    queryFn: ({ signal }): Promise<ClickySession> =>
      client(`/api/computers/${encodeURIComponent(botId)}/clicky`, "session", {
        signal,
        fallback: "Could not load Show me how",
      }),
    /*
     * Never let an older copy replace a newer one, whichever way it arrived: this runs for the
     * fetch's own answer and for every `setQueryData` the socket and the commands make. It also
     * runs for each surface's `select`, so a view that came out the same (the bar while words
     * stream into the reply) keeps its reference, and whatever drew it is not drawn again.
     */
    structuralSharing: (held: unknown, incoming: unknown) => {
      if (!isSession(incoming)) return replaceEqualDeep(held, incoming);
      const kept = newerSession(isSession(held) ? held : undefined, incoming);
      return kept === held ? held : replaceEqualDeep(held, kept);
    },
    // The events socket keeps it current; a refetch on focus would only race it.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/**
 * The phones linked to this person's account, or null on a server that has no such list yet (an
 * instance older than Clicky answers 404, and the section hides itself rather than erroring).
 */
export function mobileDevicesQueryOptions() {
  return queryOptions({
    queryKey: clickyKeys.devices(),
    queryFn: async ({ signal }): Promise<MobileDevice[] | null> => {
      try {
        const devices = await client<MobileDevice[] | undefined>(
          "/api/mobile/devices",
          "devices",
          { signal, fallback: "Could not load your phones" },
        );
        return Array.isArray(devices) ? devices : [];
      } catch (error) {
        if (httpStatusOf(error) === 404) return null;
        throw error;
      }
    },
  });
}

/*
 * The hooks below name the app's one query client rather than finding it through the provider, like
 * `use-voice-call.ts`: Clicky's switch is asked by surfaces (the screen card, the live screen) that
 * are also drawn on their own, outside any provider, and must then simply find Clicky off.
 */

/** Whether this deployment offers Clicky, and whether it can listen. Off until the server says. */
export function useClickyCapability(): { enabled: boolean; voice: boolean } {
  const capabilities = useQuery(
    deploymentCapabilitiesQueryOptions(),
    queryClient,
  );
  const clicky = capabilities.data?.clicky;
  return {
    enabled: clicky?.enabled === true,
    voice: clicky?.enabled === true && clicky.voice === true,
  };
}

/** This person's Clicky settings, defaults filled in, and whether they have arrived yet. */
export function useClickyPreferences(): ClickyPreferences & {
  loaded: boolean;
} {
  const { data: user } = useQuery(currentUserQueryOptions(), queryClient);
  const preferences = useQuery(
    userPreferencesQueryOptions(user?.id),
    queryClient,
  );
  return {
    ...clickyPreferencesOf(preferences.data),
    loaded: preferences.data !== undefined,
  };
}
