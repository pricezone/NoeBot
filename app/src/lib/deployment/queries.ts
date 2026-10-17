import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { cacheDeployment } from "@/lib/i18n/detect";
import {
  isLocale,
  type Locale,
  parseLocales,
} from "../../../../shared/i18n/locales";

/**
 * What this deployment can do, as the server is willing to say it.
 *
 * A projection, not the runtime. `/api/capabilities` is reachable before anybody has signed in, so
 * only fields somebody may know unauthenticated appear on it; the Intelligence contract and every
 * deployment secret stay on the server. See server/src/app.ts.
 */
export type DeploymentCapabilities = {
  /**
   * Whether a Bot may answer with an interface it wrote itself.
   *
   * Read by the browser because the browser owns half of this capability: the SDK's provider is what
   * offers the model the tool that generates one. A deployment that turned the server half off while
   * the browser kept offering the tool would have Bots writing whole interfaces that nothing draws,
   * so both halves read this one answer.
   */
  generativeUi: boolean;
  /**
   * Whether to show the banner offering help self-hosting OpenBot. A fork that runs OpenBot for its
   * own organization turns it off with OPENBOT_SELF_HOST_BANNER=false, and the server answers false
   * for a deployment on a paid Intelligence plan.
   */
  selfHostBanner: boolean;
  transcription?: boolean;
  voice?: boolean;
  /**
   * Whether this deployment is metered by the platform that runs it, and so has a usage figure to
   * show. Off on a deployment that brings its own model key: the account menu then has no usage row
   * and the Usage & Billing tab says the model is billed elsewhere.
   */
  usage?: boolean;
  /**
   * Where the subscription behind this deployment is managed. A link out to the platform, opened in
   * a new tab, never fetched. Absent when the server named none.
   */
  billingUrl?: string;
  /**
   * Whether chat runs carry out computer tools on the server (COMPUTER_TOOLS_IN_RUN). On, the
   * browser draws the calls and only resumes a run that stopped to wait for the person; see
   * `useFrontendTool` in lib/copilot/approval-tools.tsx.
   */
  computerToolsInRun?: boolean;
  /**
   * Clicky Mode: the companion beside the computer's screen (`enabled`), and whether it can listen to
   * hold-to-talk (`voice`, which needs transcription). Absent on an older server, which reads as off.
   */
  clicky?: { enabled: boolean; voice: boolean };
  /**
   * The interface languages this deployment offers, present only when it offers more than English:
   * absent reads as English alone, with no language switcher, which is also what an older server
   * that says nothing means.
   */
  locales?: Locale[];
  /** The language somebody who chose none starts in, when the deployment names one. */
  defaultLocale?: Locale | null;
  /**
   * The platform origin Share links go through so they open on any instance
   * (`lib/share-link.ts`): the server's `shareBaseUrl`, else the origin of its sign-in handoff's
   * return address. Absent, a Share link is this deployment's own address.
   */
  shareBase?: string;
};

export const deploymentKeys = {
  all: ["deployment"] as const,
  capabilities: () => ["deployment", "capabilities"] as const,
};

/**
 * What this deployment can do.
 *
 * From the server rather than from the build, like the sign-in options beside it: the container image
 * is built once and knows nothing about the deployment that will run it, so a capability compiled
 * into the bundle can only ever describe the build machine.
 *
 * Absent fields read as off. A server too old to answer, or one that failed to, is a server this app
 * should not assume a capability of — and for generated interfaces the fail-closed direction is the
 * safe one, because claiming it wrongly is what makes a Bot generate something nothing renders.
 */
export function deploymentCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: deploymentKeys.capabilities(),
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<DeploymentCapabilities> => {
      /*
       * The whole body, then one field off it. `/api/capabilities` answers with a bare object rather
       * than the envelope most endpoints use, which is why this reads the Response itself instead of
       * naming a key — the same shape the sign-in query uses.
       */
      const body = (await (
        await client("/api/capabilities", {
          fallback: "This deployment's capabilities could not be loaded.",
        })
      ).json()) as {
        generativeUi?: boolean;
        selfHostBanner?: boolean;
        transcription?: boolean;
        voice?: boolean;
        usage?: boolean;
        billingUrl?: string | null;
        computerToolsInRun?: boolean;
        clicky?: { enabled?: unknown; voice?: unknown } | null;
        locales?: unknown;
        defaultLocale?: unknown;
        shareBaseUrl?: unknown;
        signInHandoff?: { returnUrl?: unknown } | null;
      };

      const locales = parseLocales(
        Array.isArray(body.locales) ? body.locales.join(",") : undefined,
      );
      const defaultLocale =
        isLocale(body.defaultLocale) && locales.includes(body.defaultLocale)
          ? body.defaultLocale
          : null;
      // Remembered so the next visit's first paint already speaks the deployment's language.
      cacheDeployment({ locales, defaultLocale });

      return {
        // Only when there is a choice: absent reads as English alone, as for an older server.
        ...(locales.length > 1 ? { locales, defaultLocale } : {}),
        generativeUi: body.generativeUi === true,
        selfHostBanner: body.selfHostBanner === true,
        transcription: body.transcription === true,
        voice: body.voice === true,
        usage: body.usage === true,
        // Only when on: absent reads as off, and an older server says nothing.
        ...(body.computerToolsInRun === true
          ? { computerToolsInRun: true }
          : {}),
        // Only when on, like the flag above.
        ...(body.clicky?.enabled === true
          ? { clicky: { enabled: true, voice: body.clicky.voice === true } }
          : {}),
        // A string or nothing: the server answers null when it has no billing page, and an older
        // server answers no field at all. Both read as "no link to offer".
        ...(typeof body.billingUrl === "string" && body.billingUrl
          ? { billingUrl: body.billingUrl }
          : {}),
        ...shareBaseOf(body.shareBaseUrl, body.signInHandoff?.returnUrl),
      };
    },
  });
}

/** The first of these that is an http(s) address, as an origin: the platform share links use. */
function shareBaseOf(...candidates: unknown[]): { shareBase?: string } {
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:") {
        return { shareBase: url.origin };
      }
    } catch {
      // Not an address; try the next.
    }
  }
  return {};
}
