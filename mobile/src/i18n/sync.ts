import * as SecureStore from "expo-secure-store";
import { api } from "../api";
import { applyLocale, getLocale, storedLocale, storeLocale } from "./index";
import { type Locale, normalizeLocale, parseLocales } from "./locales";

/**
 * Keeping the phone's language and the person's preference on the server in step, the way the web
 * app does (`app/src/lib/i18n/sync.ts`).
 *
 * Once per sign-in: a choice made on this phone that never reached the server is sent again and
 * wins; otherwise the server's preference wins and is remembered here; otherwise a choice made on
 * this phone before is promoted to the server. Somebody who chose nothing anywhere stays in the
 * phone's own language.
 */

const UNSYNCED_KEY = "openbot-locale-unsynced";

async function unsynced(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(UNSYNCED_KEY)) === "1";
  } catch {
    return false;
  }
}

async function markUnsynced(value: boolean): Promise<void> {
  try {
    if (value) await SecureStore.setItemAsync(UNSYNCED_KEY, "1");
    else await SecureStore.deleteItemAsync(UNSYNCED_KEY);
  } catch {
    // The next sign-in simply does not retry; the choice is still on this phone.
  }
}

async function saveOnServer(locale: Locale): Promise<boolean> {
  try {
    await api("/api/settings/preferences", {
      method: "PATCH",
      body: { locale },
    });
    await markUnsynced(false);
    return true;
  } catch {
    await markUnsynced(true);
    return false;
  }
}

/** The languages this deployment offers, after settling which one this person speaks. */
export async function settleSignedInLocale(): Promise<Locale[]> {
  const [me, capabilities] = await Promise.all([
    api<{ locale?: string | null }>("/api/me").catch(() => null),
    api<{ locales?: string[] }>("/api/capabilities").catch(() => null),
  ]);
  const stored = await storedLocale();
  const server = normalizeLocale(me?.locale);
  if (stored && (await unsynced())) {
    applyLocale(stored);
    await saveOnServer(stored);
  } else if (server) {
    applyLocale(server);
    await storeLocale(server);
  } else if (stored) {
    applyLocale(stored);
    await saveOnServer(stored);
  }
  return parseLocales(capabilities?.locales?.join(","));
}

/**
 * The person chose a language on this phone: it changes at once, is remembered here, and is saved
 * to their preferences. A save that fails keeps the choice and says so; it is sent again at the
 * next sign-in.
 */
export async function chooseLocale(locale: Locale): Promise<boolean> {
  if (locale === getLocale()) return true;
  applyLocale(locale);
  await storeLocale(locale);
  return saveOnServer(locale);
}
