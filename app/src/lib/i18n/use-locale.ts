import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import type { Locale } from "../../../../shared/i18n/locales";
import { cachedDeployment, enabledLocales, markUnsynced } from "./detect";
import { useInterfaceLocale } from "./index";
import { ensureLocale } from "./set-locale";
import { recordLocaleLocally, saveLocalePreference } from "./sync";

export { useInterfaceLocale };

/** The languages this browser may switch between, as soon as the deployment has said. */
export function useEnabledLocales(): Locale[] {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  return enabledLocales(
    capabilities.data?.locales ?? cachedDeployment().locales,
  );
}

/**
 * The interface language and the way to change it.
 *
 * A switch is immediate here and saved behind: the interface redraws in the new language, this
 * browser remembers it, and a signed-in person's account is told. A save that fails leaves the
 * choice standing in this browser, says so (`syncFailed`), and is sent again at the next boot, so
 * the server's older answer never quietly switches the person back.
 */
export function useLocale() {
  const locale = useInterfaceLocale();
  const enabled = useEnabledLocales();
  const queryClient = useQueryClient();
  const { data: user } = useQuery(currentUserQueryOptions());
  const userId = user?.id;
  const [pending, setPending] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);

  const setLocale = useCallback(
    async (next: Locale) => {
      setPending(true);
      setSyncFailed(false);
      recordLocaleLocally(queryClient, next);
      try {
        await ensureLocale(next);
        if (userId) {
          markUnsynced(true);
          await saveLocalePreference(queryClient, userId, next).catch(() =>
            setSyncFailed(true),
          );
        }
      } finally {
        setPending(false);
      }
    },
    [queryClient, userId],
  );

  return { locale, enabled, setLocale, pending, syncFailed };
}
