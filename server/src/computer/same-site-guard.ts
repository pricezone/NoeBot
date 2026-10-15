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
  /**
   * The methods whose body is checked: POST, PUT and PATCH unless said, or "unsafe" for every
   * method but GET, HEAD and OPTIONS.
   */
  bodyMethods?: readonly string[] | "unsafe";
  /** Multipart form data is taken too: an upload. */
  multipart?: boolean;
};

const BODY_METHODS = ["POST", "PUT", "PATCH"];

/** The methods that only read. Everything else may change something. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a request asks to become a WebSocket: `Upgrade` names it, alone or in a list. */
export function isWebSocketUpgrade(headers: Headers): boolean {
  return (headers.get("upgrade") ?? "")
    .toLowerCase()
    .split(",")
    .some((token) => token.trim() === "websocket");
}

/**
 * Whether a request carries a body: a positive `Content-Length`, any `Content-Length` that is not
 * a number (a server further on may still read one), chunked transfer, or a body stream.
 */
function hasBodyOf(request: {
  headers: Headers;
  body?: ReadableStream | null;
}): boolean {
  const length = request.headers.get("content-length")?.trim();
  if (length !== undefined && length !== "")
    return /^\d+$/.test(length) ? Number(length) > 0 : true;
  return (
    request.headers.has("transfer-encoding") ||
    (request.body !== undefined && request.body !== null)
  );
}

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
  const method = request.method.toUpperCase();
  if (
    (bodyMethods === "unsafe"
      ? !SAFE_METHODS.has(method)
      : bodyMethods.includes(method)) &&
    (options.jsonBodies !== "browser" || fromBrowser(request.headers))
  ) {
    const type = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (
      hasBodyOf(request) &&
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

/** Whether a path is one of the exemptions above, for this method. */
export function exemptFromSameSite(method: string, pathname: string): boolean {
  const upper = method.toUpperCase();
  return SAME_SITE_EXEMPT.some(
    (exemption) =>
      exemption.pattern.test(pathname) &&
      (!exemption.methods || exemption.methods.includes(upper)),
  );
}

/**
 * A request's path as it arrived (still percent-encoded) and as the router reads it. Hono slices the
 * path out of the URL and decodes it with `decodeURI`, so `/%61pi/settings` is routed to
 * `/api/settings`; this decodes it the same way, so the guard decides on the path that will be
 * served rather than on the one that was written.
 */
export function requestPaths(url: string): { raw: string; decoded: string } {
  const start = url.indexOf("/", url.indexOf(":") + 3);
  if (start === -1) return { raw: "/", decoded: "/" };
  let end = url.length;
  for (const mark of ["?", "#"]) {
    const at = url.indexOf(mark, start);
    if (at !== -1 && at < end) end = at;
  }
  const raw = url.slice(start, end) || "/";
  const decodable = raw.includes("%25") ? raw.replace(/%25/g, "%2525") : raw;
  let decoded: string;
  try {
    decoded = decodeURI(decodable);
  } catch {
    decoded = decodable.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURI(run);
      } catch {
        return run;
      }
    });
  }
  return { raw, decoded };
}

/** No empty, `.` or `..` segment: a path that means what it says. */
function plainPath(path: string): boolean {
  return path
    .split("/")
    .slice(1)
    .every(
      (segment, index, all) =>
        (segment !== "" || index === all.length - 1) &&
        segment !== "." &&
        segment !== "..",
    );
}

/**
 * Whether a request is exempt: its path as written AND as routed both name an exemption, and
 * neither hides a step back or an empty segment. An encoding that turns one into another is not.
 */
function exempt(method: string, paths: { raw: string; decoded: string }) {
  return (
    plainPath(paths.raw) &&
    plainPath(paths.decoded) &&
    exemptFromSameSite(method, paths.raw) &&
    exemptFromSameSite(method, paths.decoded)
  );
}

/** The two routes a browser uploads a file to, as multipart form data. */
const MULTIPART_ROUTES = [
  /^\/api\/channels\/[^/]+\/attachments$/,
  /^\/api\/audio\/transcriptions$/,
];

/**
 * The global rules, for one request: what the middleware below answers, and what the live screen's
 * socket (upgraded before Hono sees it) is asked too.
 *
 * Every request that may change something (any method but GET, HEAD and OPTIONS) and every
 * WebSocket upgrade, on ANY path: a prefix check on the path as written is what an encoded path
 * (`/%61pi/...`), a double slash or a step back walks around, since the router decodes it.
 */
export function apiSameSiteVerdict(
  request: {
    method: string;
    url: string;
    headers: Headers;
    body?: ReadableStream | null;
  },
  trusted: ReadonlySet<string>,
): SameSiteVerdict {
  const method = request.method.toUpperCase();
  if (!isWebSocketUpgrade(request.headers) && SAFE_METHODS.has(method))
    return { ok: true };
  const paths = requestPaths(request.url);
  if (exempt(method, paths)) return { ok: true };
  return checkSameSite(request, trusted, {
    jsonBodies: "browser",
    bodyMethods: "unsafe",
    multipart:
      method === "POST" &&
      MULTIPART_ROUTES.some(
        (route) => route.test(paths.raw) && route.test(paths.decoded),
      ),
  });
}

/** The trusted origins of a deployment, ready for `apiSameSiteVerdict`. */
export function trustedOriginsOf(origins: readonly string[]): Set<string> {
  return trustedSet(origins);
}

/**
 * The same rules for the whole server, registered before every route: a sibling instance's page
 * (the same site, carrying the person's cookie) can change nothing through any of it, where before
 * only the computer routes, the phones and the sockets refused it.
 *
 * Only what may change something is checked: every method but GET, HEAD and OPTIONS, and every
 * WebSocket upgrade, whatever the path. A GET, HEAD or OPTIONS passes, since OAuth and SSO callbacks,
 * the sign-in handoff, the plugin consent callback and attachment links all arrive as a top-level
 * navigation from another site. A body is required to be JSON only of a browser (an `Origin` or any
 * `Sec-Fetch-*`), except a multipart upload on the two upload routes; the phone and anything else
 * that is not a browser sends neither header and passes, as it always did. The exemptions are
 * checked before any header is read, against the path as written and as routed.
 *
 * The per-router guards stay where they were: they also check reads, which this one does not.
 */
export function apiSameSiteGuard(
  origins: readonly string[],
): MiddlewareHandler {
  const trusted = trustedSet(origins);
  return async (context, next) => {
    const verdict = apiSameSiteVerdict(context.req.raw, trusted);
    if (!verdict.ok)
      return context.json({ error: verdict.error }, verdict.status);
    await next();
  };
}
