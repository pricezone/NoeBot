import {
  LOCALES,
  type Locale,
  normalizeLocale,
  parseLocales,
} from "../../../shared/i18n/locales";

/**
 * Which interface languages this deployment offers, and which one a person who has chosen none
 * starts in.
 *
 * `OPENBOT_LOCALES` lists the languages (`"en,el"`); English is always among them. Unset, every
 * language this build has is offered, so the Language choice shows; `OPENBOT_LOCALES=en` offers
 * English alone and hides it. `OPENBOT_DEFAULT_LOCALE` is the starting language for somebody with
 * no choice of their own, and counts only when it is one of the offered languages; unset, their
 * browser's languages decide.
 *
 * Read from the environment on each call rather than through `config.ts`: two optional settings with
 * nothing to validate at boot, and a capability that should follow the process's environment as it
 * is, which is also what lets a test set them per case.
 */
export type DeploymentLocales = {
  locales: Locale[];
  defaultLocale: Locale | null;
};

export function deploymentLocales(
  environment: Record<string, string | undefined> = process.env,
): DeploymentLocales {
  const locales = parseLocales(
    environment.OPENBOT_LOCALES ?? LOCALES.join(","),
  );
  const preferred = normalizeLocale(environment.OPENBOT_DEFAULT_LOCALE);
  return {
    locales,
    defaultLocale: preferred && locales.includes(preferred) ? preferred : null,
  };
}
