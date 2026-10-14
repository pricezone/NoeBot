import type { QueryClient } from "@tanstack/react-query";
import {
  type AuthenticatedUser,
  currentUserQueryOptions,
} from "@/lib/auth/queries";
import { client } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { userPreferencesQueryOptions } from "@/lib/settings/message-list";
import type { Locale } from "../../../../shared/i18n/locales";
import type { UserPreferences } from "../../../../shared/user-preferences";
import {
  browserLanguages,
  cachedDeployment,
  enabledLocales,
  isUnsynced,
  markUnsynced,
  resolveLocale,
  storedLocale,
  storeLocale,
} from "./detect";
import { ensureLocale } from "./set-locale";

/**
 * Keeps the signed-in person's language and the server's record of it in agreement.
 */

/** Tells the server, and every cache that holds the answer, which language this person chose. */
export async function saveLocalePreference(
  queryClient: QueryClient,
  userId: string,
  locale: Locale,
): Promise<void> {
  const preferences = await client<UserPreferences>(
    "/api/settings/preferences",
    "preferences",
    {
      method: "PATCH",
      body: { locale },
      fallback: "Could not save your language",
    },
  );
  queryClient.setQueryData(
    userPreferencesQueryOptions(userId).queryKey,
    preferences,
  );
  markUnsynced(false);
}

/** The person's choice, written where the next boot and every open screen will read it. */
export function recordLocaleLocally(
  queryClient: QueryClient,
  locale: Locale,
): void {
  storeLocale(locale);
  queryClient.setQueryData(
    currentUserQueryOptions().queryKey,
    (user: AuthenticatedUser | null | undefined) =>
      user ? { ...user, locale } : user,
  );
}

let settledFor: string | undefined;

/**
 * Settles the language for a signed-in person, once per page load, before the app draws.
 *
 * The server's record wins over this browser's memory, so a choice follows the person between
 * devices, except for a choice this browser made and could not save: that one is the newest word
 * and is sent again. A choice this browser made while signed out, for a person whose server knows
 * none, is promoted to the account. A language nobody chose (the deployment default, the browser's)
 * is used and never written anywhere.
 */
export async function settleSignedInLocale(
  queryClient: QueryClient,
  user: AuthenticatedUser,
): Promise<void> {
  if (settledFor === user.id) return;
  settledFor = user.id;
  const capabilities = await queryClient
    .ensureQueryData(deploymentCapabilitiesQueryOptions())
    .catch(() => undefined);
  const deployment = capabilities
    ? {
        locales: capabilities.locales ?? ["en"],
        defaultLocale: capabilities.defaultLocale ?? null,
      }
    : cachedDeployment();
  const enabled = enabledLocales(deployment.locales);
  const stored = storedLocale();
  const unsynced = isUnsynced();
  const server = user.locale ?? null;
  const target = resolveLocale({
    server,
    stored,
    unsynced,
    deploymentDefault: deployment.defaultLocale,
    browser: browserLanguages(),
    enabled,
  });

  const push = (locale: Locale) => {
    markUnsynced(true);
    void saveLocalePreference(queryClient, user.id, locale).catch(() => {
      // Still unsynced: the next boot tries again, and the choice stands here meanwhile.
    });
  };
  if (stored && enabled.includes(stored) && (unsynced || !server)) {
    if (stored !== server) push(stored);
    else markUnsynced(false);
  } else if (server && enabled.includes(server)) {
    storeLocale(server);
  }
  await ensureLocale(target).catch(() => {});
}

/** Back to a fresh page load, for tests. */
export function resetSettledLocaleForTests(): void {
  settledFor = undefined;
}
