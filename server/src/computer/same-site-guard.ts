import type { MiddlewareHandler } from "hono";
import type { DeploymentConfig } from "../config";

/**
 * Only this deployment's own pages may drive its computers and phones.
 *
 * A hosted Noë Bot shares its parent domain with every other subscriber's (`<id>.hypernoesis.app`),
 * and that parent is not on the Public Suffix List, so the browser counts a sibling instance as the
 * SAME SITE: its `SameSite=Lax` session cookie travels with requests a page on a sibling makes. A
 * script on somebody else's instance could otherwise open this person's Clicky socket and read their
 * screen, or post commands ("Do it for me", approve) and the person's own mouse and keyboard.
 *
 * Three rules, for every request to the computer routes (the live socket and the person's input
 * included) and to `/api/mobile`:
 *
 * - An `Origin` must be this deployment's own (its host) or one it was configured to trust
 *   (`TRUSTED_ORIGINS`, the sign-in base URL, the public and app URLs).
 * - `Sec-Fetch-Site: cross-site` or `same-site` is refused unless that `Origin` is one it was
 *   configured to trust: the desktop's local app on another port is same-site and trusted, a sibling
 *   instance is same-site and is not.
 * - A body sent with POST, PUT or PATCH must be JSON. A form or `text/plain` post is the one kind a
 *   page elsewhere can send without asking first, and nothing here takes one.
 *
 * The phone sends neither header and passes, as does anything that is not a browser: a cookie it
 * holds was handed to it, not lent to it by a page.
 */

export const CROSS_SITE_REFUSAL =
  "This request came from another site, so it was refused.";

/** Already a sentence the app translates; a body that is not JSON is a request it cannot read. */
const NOT_JSON = "Supply a valid request.";

export type SameSiteVerdict =
  | { ok: true }
  | { ok: false; status: 403 | 415; error: string };

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === "null" ? null : url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** The origins this deployment trusts besides its own host. */
export function deploymentOrigins(
  config: Pick<DeploymentConfig, "auth" | "publicUrl" | "appUrl">,
): string[] {
  return [
    config.auth?.baseUrl,
    config.publicUrl,
    config.appUrl,
    ...(config.auth?.trustedOrigins ?? []),
  ].flatMap((value) => {
    const origin = value ? originOf(value) : null;
    return origin ? [origin] : [];
  });
}

export function checkSameSite(
  request: {
    method: string;
    url: string;
    headers: Headers;
    body?: ReadableStream | null;
  },
  trusted: ReadonlySet<string>,
): SameSiteVerdict {
  const refused = {
    ok: false,
    status: 403,
    error: CROSS_SITE_REFUSAL,
  } as const;
  const origin = request.headers.get("origin");
  let explicit = false;
  if (origin !== null) {
    const normalized = originOf(origin);
    if (!normalized) return refused;
    explicit = trusted.has(normalized);
    let host = request.headers.get("host")?.toLowerCase();
    if (!host) {
      try {
        host = new URL(request.url).host.toLowerCase();
      } catch {
        host = undefined;
      }
    }
    const sameHost = Boolean(host) && new URL(normalized).host === host;
    if (!explicit && !sameHost) return refused;
  }
  const site = request.headers.get("sec-fetch-site")?.toLowerCase();
  if ((site === "cross-site" || site === "same-site") && !explicit)
    return refused;
  if (["POST", "PUT", "PATCH"].includes(request.method.toUpperCase())) {
    const length = request.headers.get("content-length");
    const hasBody =
      length !== null && length.trim() !== ""
        ? Number(length) > 0
        : request.headers.has("transfer-encoding") ||
          (request.body !== undefined && request.body !== null);
    const type = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (hasBody && !/^application\/json\s*(;|$)/.test(type))
      return { ok: false, status: 415, error: NOT_JSON };
  }
  return { ok: true };
}

/** The rules above as a Hono middleware, for a router and everything under it. */
export function sameSiteGuard(origins: readonly string[]): MiddlewareHandler {
  const trusted = new Set(
    origins.flatMap((value) => {
      const origin = originOf(value);
      return origin ? [origin] : [];
    }),
  );
  return async (context, next) => {
    const verdict = checkSameSite(context.req.raw, trusted);
    if (!verdict.ok)
      return context.json({ error: verdict.error }, verdict.status);
    await next();
  };
}
