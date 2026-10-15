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

/**
 * How strict the body rule is. The computer routes, the phones and the sockets take JSON from
 * anybody (the default); the global guard on `/api` asks it of browsers only, on every method that
 * changes something, and lets the two upload routes take multipart form data.
 */
export type SameSiteOptions = {
  /** Whose bodies must be JSON: everybody's, or only a browser's (an `Origin` or any `Sec-Fetch-*`). */
  jsonBodies?: "all" | "browser";
  /** The methods whose body is checked. POST, PUT and PATCH unless said. */
  bodyMethods?: readonly string[];
  /** Multipart form data is taken too: an upload. */
  multipart?: boolean;
};

const BODY_METHODS = ["POST", "PUT", "PATCH"];

/** Whether a request came from a browser page: it says where from, or how it was fetched. */
function fromBrowser(headers: Headers): boolean {
  if (headers.has("origin")) return true;
  for (const name of headers.keys())
    if (name.toLowerCase().startsWith("sec-fetch-")) return true;
  return false;
}

export function checkSameSite(
  request: {
    method: string;
    url: string;
    headers: Headers;
    body?: ReadableStream | null;
  },
  trusted: ReadonlySet<string>,
  options: SameSiteOptions = {},
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
  const bodyMethods = options.bodyMethods ?? BODY_METHODS;
  if (
    bodyMethods.includes(request.method.toUpperCase()) &&
    (options.jsonBodies !== "browser" || fromBrowser(request.headers))
  ) {
    const length = request.headers.get("content-length");
    const hasBody =
      length !== null && length.trim() !== ""
        ? Number(length) > 0
        : request.headers.has("transfer-encoding") ||
          (request.body !== undefined && request.body !== null);
    const type = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (
      hasBody &&
      !/^application\/json\s*(;|$)/.test(type) &&
      !(options.multipart && /^multipart\/form-data\s*(;|$)/.test(type))
    )
      return { ok: false, status: 415, error: NOT_JSON };
  }
  return { ok: true };
}

function trustedSet(origins: readonly string[]): Set<string> {
  return new Set(
    origins.flatMap((value) => {
      const origin = originOf(value);
      return origin ? [origin] : [];
    }),
  );
}

/** The rules above as a Hono middleware, for a router and everything under it. */
export function sameSiteGuard(origins: readonly string[]): MiddlewareHandler {
  const trusted = trustedSet(origins);
  return async (context, next) => {
    const verdict = checkSameSite(context.req.raw, trusted);
    if (!verdict.ok)
      return context.json({ error: verdict.error }, verdict.status);
    await next();
  };
}

/**
 * Where other sites and local apps post by design, so the global guard leaves them to their own
 * checks (a signature, a bearer token, the identity provider's assertion):
 *
 * - SAML's assertion consumer and logout, and an OAuth `form_post` callback: the identity
 *   provider's own page posts a form here, often with `Origin: null`;
 * - SCIM, the webhooks (Twilio, Slack, Teams, SNS, GitHub, signed triggers), the agents' tool
 *   callback and the local model proxy, which hold a token rather than a cookie;
 * - the desktop app's own endpoints, which hold the desktop's token.
 *
 * Matched before anything about the request is read, since an identity provider's page sends an
 * `Origin` that never parses.
 */
const SAME_SITE_EXEMPT: readonly { pattern: RegExp; methods?: string[] }[] = [
  { pattern: /^\/api\/auth\/sso\/saml2\/sp\/(?:acs|slo)(?:\/|$)/ },
  { pattern: /^\/api\/auth\/callback\//, methods: ["POST"] },
  { pattern: /^\/api\/auth\/scim(?:\/|$)/ },
  { pattern: /^\/api\/delivery\/webhooks(?:\/|$)/ },
  { pattern: /^\/api\/events\/(?:triggers|email|github)(?:\/|$)/ },
  { pattern: /^\/api\/agent-tools\/call$/ },
  { pattern: /^\/api\/model-provider(?:\/|$)/ },
  { pattern: /^\/api\/host-access\/desktop(?:\/|$)/ },
  { pattern: /^\/api\/desktop(?:\/|$)/ },
];

/** Whether a request to `/api` is one of the exemptions above. */
export function exemptFromSameSite(method: string, pathname: string): boolean {
  const upper = method.toUpperCase();
  return SAME_SITE_EXEMPT.some(
    (exemption) =>
      exemption.pattern.test(pathname) &&
      (!exemption.methods || exemption.methods.includes(upper)),
  );
}

/** The two routes a browser uploads a file to, as multipart form data. */
const MULTIPART_ROUTES = [
  /^\/api\/channels\/[^/]+\/attachments$/,
  /^\/api\/audio\/transcriptions$/,
];

const CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * The same rules for the whole of `/api`, registered before every route: a sibling instance's page
 * (the same site, carrying the person's cookie) can change nothing through any of it, where before
 * only the computer routes, the phones and the sockets refused it.
 *
 * Only what changes something is checked: POST, PUT, PATCH, DELETE and a WebSocket upgrade. A GET,
 * HEAD or OPTIONS passes, since OAuth and SSO callbacks, the sign-in handoff, the plugin consent
 * callback and attachment links all arrive as a top-level navigation from another site. A body is
 * required to be JSON only of a browser (an `Origin` or any `Sec-Fetch-*`), except a multipart upload
 * on the two upload routes; the phone and anything else that is not a browser sends neither header
 * and passes, as it always did. The exemptions are checked first, before any header is read.
 *
 * The per-router guards stay where they were: they also check reads, which this one does not.
 */
export function apiSameSiteGuard(
  origins: readonly string[],
): MiddlewareHandler {
  const trusted = trustedSet(origins);
  return async (context, next) => {
    const request = context.req.raw;
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return next();
    }
    if (pathname !== "/api" && !pathname.startsWith("/api/")) return next();
    const method = request.method.toUpperCase();
    if (exemptFromSameSite(method, pathname)) return next();
    const upgrade =
      request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (!upgrade && !CHANGING_METHODS.has(method)) return next();
    const verdict = checkSameSite(request, trusted, {
      jsonBodies: "browser",
      bodyMethods: [...CHANGING_METHODS],
      multipart:
        method === "POST" &&
        MULTIPART_ROUTES.some((route) => route.test(pathname)),
    });
    if (!verdict.ok)
      return context.json({ error: verdict.error }, verdict.status);
    await next();
  };
}
