import { createHmac, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { type Locale, normalizeLocale } from "../../../shared/i18n/locales";
import {
  MOBILE_DEVICE_NAME_LIMIT,
  MOBILE_LINK_AUDIENCE,
  type MobileLinkResponse,
  type MobilePlatform,
} from "../../../shared/mobile-link";
import { deploymentLocales } from "../i18n/deployment-locale";

/**
 * Signing in from the platform that runs this deployment.
 *
 * A deployment run for one person by a platform that already knows who they are (HyperNoesis runs
 * one of these per subscriber) has no need of a third identity provider, and a public address rules
 * single-user mode out. So the platform signs them in: it holds a secret only it and this deployment
 * share, mints a token with it, and sends the browser here. The token says who (`sub`), for which
 * deployment (`iid`), when (`iat`, `exp`, sixty seconds apart) and which one it is (`jti`, used
 * once). Everything about it is checkable without a round trip and nothing in it is secret, which is
 * why it is signed rather than sealed.
 *
 * Who it admits is decided here, not by the token: the one address the deployment was configured
 * with. A valid token for anybody else is refused, so a leaked secret is worth one person's
 * session and never a way in for a second person.
 */

export type SignInHandoffClaims = {
  /** The person's email. */
  sub: string;
  /** The deployment the token was minted for. */
  iid: string;
  /** Seconds since the epoch. */
  iat: number;
  exp: number;
  /** Single-use id. */
  jti: string;
  /**
   * The language the platform speaks to this person in, such as "el". Optional, and only ever a
   * suggestion: see `SignInHandoffOptions.seedLocale`.
   */
  locale?: string;
  /**
   * Who the token is for. Absent on a browser's token; `mobile` on one the platform minted for the
   * person's phone to trade for a session of its own (`POST /signin-handoff/mobile`). Each endpoint
   * refuses the other's, so a token copied out of a phone cannot sign a browser in, and a link a
   * browser followed cannot be replayed by an app as a phone.
   */
  aud?: string;
};

/** How far ahead of this clock an `iat` may sit before the token is refused as not yet valid. */
const CLOCK_SKEW_SECONDS = 30;

/**
 * The longest a token may be minted to live. The platform mints them for sixty seconds; one that
 * claims longer was not minted to the contract, and a leaked one would stay usable longer than
 * anybody intended.
 */
const MAX_TOKEN_LIFETIME_SECONDS = 120;

/** How long a "don't remember me" session lives: Better Auth's one day, and a little slack. */
const DONT_REMEMBER_LIFETIME_MS = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;

function isClaims(value: unknown): value is SignInHandoffClaims {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sub === "string" &&
    typeof record.iid === "string" &&
    typeof record.iat === "number" &&
    typeof record.exp === "number" &&
    typeof record.jti === "string" &&
    (record.locale === undefined || typeof record.locale === "string") &&
    (record.aud === undefined || typeof record.aud === "string")
  );
}

/**
 * The claims a token carries, or null for anything that cannot be trusted: a missing or malformed
 * token, a signature made with another secret, an expired or not-yet-valid token, or one minted for
 * another deployment. The signature is compared in constant time.
 */
export function verifySignInHandoffToken(
  token: string | undefined | null,
  secret: string,
  options: { deploymentId?: string; now?: number } = {},
): SignInHandoffClaims | null {
  if (!token) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const payload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = createHmac("sha256", secret).update(payload).digest();
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  ) {
    return null;
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isClaims(claims)) return null;
  if (options.deploymentId && claims.iid !== options.deploymentId) return null;

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.exp <= nowSeconds) return null;
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (claims.exp - claims.iat > MAX_TOKEN_LIFETIME_SECONDS) return null;
  return claims;
}

/**
 * Where to land after signing in: a page on this deployment, or its root.
 *
 * Checked on the resolved URL, not the raw string. `/` followed by a backslash or a control
 * character looks like a path and is not one: browsers read `/\evil.example` as `//evil.example`,
 * so a prefix test alone would send a signed-in person to somebody else's site. Anything that does
 * not resolve to this origin goes to the root instead.
 */
/** A backslash, or a character below space (or DEL): none of them belongs in a path. */
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\" || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function localRedirect(value: string | undefined, base: URL): string {
  const home = new URL("/", base).toString();
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    hasUnsafeCharacter(value)
  ) {
    return home;
  }
  /*
   * Returned resolved, never as a path to parse again: `/.//evil.example` resolves to a path that
   * begins with `//` on this origin, which re-parsed as a redirect target is another host.
   */
  const target = new URL(value, base);
  if (target.origin !== base.origin || target.pathname.startsWith("//")) {
    return home;
  }
  return target.toString();
}

/** The language a token suggests, when it is one this deployment offers; otherwise none. */
export function handoffLocale(
  claims: Pick<SignInHandoffClaims, "locale">,
  offered: readonly Locale[],
): Locale | null {
  const suggested = normalizeLocale(claims.locale);
  return suggested && offered.includes(suggested) ? suggested : null;
}

/** The fields of a user this endpoint reads. */
type HandoffUser = { id: string; email: string; name?: string | null };

/**
 * The `Cookie` header that carries exactly these cookies, read back from the `Set-Cookie` headers
 * Better Auth wrote: the names with their prefixes (`__Host-` on https here) and the signed values
 * as they were set, so the header is byte for byte what a browser would send. Null when any of them
 * is missing.
 */
export function sessionCookieHeader(
  headers: Headers | undefined,
  names: readonly string[],
): string | null {
  const set = new Map<string, string>();
  for (const line of headers?.getSetCookie() ?? []) {
    const pair = line.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    set.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  const pairs: string[] = [];
  for (const name of names) {
    const value = set.get(name);
    if (!value) return null;
    pairs.push(`${name}=${value}`);
  }
  return pairs.join("; ");
}

export type SignInHandoffOptions = {
  secret: string;
  /** The one address a token may sign in, compared case-insensitively. */
  email: string;
  /** This deployment's id; a token for another one is refused. Unset skips that check. */
  deploymentId?: string;
  /**
   * Records the language the platform named, for somebody who has not chosen one here.
   *
   * Their own choice in this deployment always stands: the write is conditional on there being
   * none, so the next sign-in from a Greek platform does not undo somebody switching to English
   * here. A language this deployment does not offer is not recorded, which is what keeps everybody
   * in English until a deployment turns Greek on. Never fails the sign-in.
   */
  seedLocale?: (userId: string, locale: Locale) => Promise<void>;
  /**
   * Records a phone linked through `POST /signin-handoff/mobile` and answers its device id. Absent,
   * the mobile endpoint refuses every link: a deployment that cannot list and revoke phones must not
   * hand sessions to them. See `shared/mobile-link.ts`.
   */
  onMobileLinked?: (input: MobileLinkedInput) => Promise<{ deviceId: string }>;
  /** Told when a phone's link was refused (not valid here, or already used), for the audit trail. */
  onMobileRefused?: (input: {
    reason: "handoff_refused" | "handoff_replayed";
  }) => Promise<void>;
};

/** A phone that has just traded a mobile token for a session. */
export type MobileLinkedInput = {
  userId: string;
  sessionId: string;
  device: { name: string; platform: MobilePlatform };
  /** The phone's own id from its last link, unchecked: the recorder decides whether it counts. */
  previousDeviceId?: string;
};

/**
 * The Better Auth plugin: a GET endpoint at `/signin-handoff` under the auth base path, and the
 * phone's POST at `/signin-handoff/mobile` (below), sharing one memory of spent tokens.
 *
 * On success it creates the person's account if this is their first visit (the ordinary user hooks
 * run, so the configured administrator role and the deny list apply), opens a session, sets the
 * cookie and redirects to the page asked for. On any refusal it redirects to the sign-in screen with
 * a reason in the query, which that screen shows; a refusal is never a JSON error, because the
 * person arriving here is a browser following a link, not a client reading a body.
 */
export function signInHandoff(options: SignInHandoffOptions): BetterAuthPlugin {
  const admitted = options.email.trim().toLowerCase();
  /*
   * Tokens already spent, by id, until they would have expired anyway. In memory: a deployment
   * is one process, and a restart forgets only tokens that are at most sixty seconds old.
   */
  const spent = new Map<string, number>();
  const remember = (claims: SignInHandoffClaims): boolean => {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, exp] of spent) if (exp <= now) spent.delete(id);
    if (spent.has(claims.jti)) return false;
    spent.set(claims.jti, claims.exp);
    return true;
  };

  /**
   * The person a verified token names: their account, made on their first visit (the ordinary user
   * hooks run, so the configured administrator role and the deny list apply), and the platform's
   * language for them recorded when they have not chosen one here.
   */
  const admit = async <U extends HandoffUser>(
    adapter: {
      findUserByEmail: (email: string) => Promise<{ user: U } | null>;
      createUser: (
        user: { email: string; emailVerified: boolean; name: string },
        context: { method: string },
      ) => Promise<U>;
    },
    claims: SignInHandoffClaims,
  ): Promise<U> => {
    const existing = await adapter.findUserByEmail(admitted);
    const user =
      existing?.user ??
      (await adapter.createUser(
        {
          email: admitted,
          emailVerified: true,
          name: admitted.split("@")[0] ?? admitted,
        },
        { method: "signin-handoff" },
      ));
    const suggested = handoffLocale(claims, deploymentLocales().locales);
    if (suggested && options.seedLocale)
      await options.seedLocale(user.id, suggested).catch(() => {
        // A language not recorded is English until they choose; the sign-in goes on.
      });
    return user;
  };

  return {
    id: "signin-handoff",
    /*
     * A "don't remember me" session (a phone's, among others) never lives past its day, whatever
     * cookie the request carries. Better Auth only leaves it alone when the request also sends the
     * `dont_remember` cookie; a copy of the phone's session cookie sent without it would otherwise be
     * slid to a week on first use. So the store refuses to move such a session's expiry at all.
     */
    init: () => ({
      options: {
        databaseHooks: {
          session: {
            update: {
              before: async (
                data: Record<string, unknown>,
                context: unknown,
              ) => {
                if (!("expiresAt" in data) || !data.expiresAt) return;
                const current = (
                  context as {
                    context?: {
                      session?: {
                        session?: { createdAt?: unknown; expiresAt?: unknown };
                      } | null;
                    };
                  } | null
                )?.context?.session?.session;
                if (!current) return;
                const created = new Date(String(current.createdAt)).getTime();
                const expires = new Date(String(current.expiresAt)).getTime();
                if (!Number.isFinite(created) || !Number.isFinite(expires))
                  return;
                if (expires - created > DONT_REMEMBER_LIFETIME_MS) return;
                return { data: { ...data, expiresAt: new Date(expires) } };
              },
            },
          },
        },
      },
    }),
    endpoints: {
      signInHandoff: createAuthEndpoint(
        "/signin-handoff",
        {
          method: "GET",
          query: z.object({
            token: z.string().min(1),
            redirect: z.string().optional(),
          }),
        },
        async (ctx) => {
          const signIn = new URL("/sign", ctx.context.baseURL);
          const refuse = (reason: string): never => {
            signIn.searchParams.set("error", reason);
            throw ctx.redirect(signIn.toString());
          };

          const claims = verifySignInHandoffToken(
            ctx.query.token,
            options.secret,
            options.deploymentId ? { deploymentId: options.deploymentId } : {},
          );
          if (!claims) return refuse("handoff_refused");
          // A browser's token names no audience: a phone's, or any other, is not for a browser.
          if (claims.aud !== undefined) return refuse("handoff_refused");
          if (claims.sub.trim().toLowerCase() !== admitted) {
            return refuse("handoff_refused");
          }
          if (!remember(claims)) return refuse("handoff_replayed");

          const user = await admit(ctx.context.internalAdapter, claims);

          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          await setSessionCookie(ctx, { session, user });

          throw ctx.redirect(
            localRedirect(ctx.query.redirect, new URL(ctx.context.baseURL)),
          );
        },
      ),
      /**
       * A phone linked through the HyperNoesis app: a `mobile` token traded for a session of its own.
       *
       * The same checks as the browser's endpoint (signature, deployment, expiry, the one admitted
       * address, single use, the language), plus the audience. Every answer is JSON, never a
       * redirect: the caller is an app reading a body. The session is a "don't remember me" one,
       * which Better Auth makes last a day and never extends, and the phone is handed the exact
       * Cookie header to send with it (see `shared/mobile-link.ts`). Nothing is set in the response's
       * own cookies: a native HTTP stack keeps a jar of its own, and a second copy of the session in
       * it would travel beside the header the phone sends.
       */
      signInHandoffMobile: createAuthEndpoint(
        "/signin-handoff/mobile",
        {
          method: "POST",
          body: z.object({
            token: z.string().min(1).max(4096),
            device: z.object({
              name: z.string().trim().min(1).max(MOBILE_DEVICE_NAME_LIMIT),
              platform: z.enum(["ios", "android"]),
            }),
            previousDeviceId: z.string().trim().min(1).max(200).optional(),
          }),
        },
        async (ctx) => {
          const refuse = async (
            code: "handoff_refused" | "handoff_replayed",
            status: "UNAUTHORIZED" | "CONFLICT",
          ): Promise<never> => {
            // Recorded: a refused phone link is somebody holding a token that did not work.
            await options
              .onMobileRefused?.({ reason: code })
              .catch(() => undefined);
            throw new APIError(status, {
              code,
              message:
                status === "CONFLICT"
                  ? "This sign-in link was already used. Ask for a new one."
                  : "This sign-in link is not valid here.",
            });
          };
          const linked = options.onMobileLinked;
          if (!linked) {
            throw new APIError("NOT_FOUND", {
              code: "mobile_link_unavailable",
              message: "Linking a phone is not available on this deployment.",
            });
          }
          const claims = verifySignInHandoffToken(
            ctx.body.token,
            options.secret,
            options.deploymentId ? { deploymentId: options.deploymentId } : {},
          );
          if (!claims) return refuse("handoff_refused", "UNAUTHORIZED");
          // A browser's token is for the browser's endpoint, never for a phone.
          if (claims.aud !== MOBILE_LINK_AUDIENCE)
            return refuse("handoff_refused", "UNAUTHORIZED");
          if (claims.sub.trim().toLowerCase() !== admitted)
            return refuse("handoff_refused", "UNAUTHORIZED");
          if (!remember(claims)) return refuse("handoff_replayed", "CONFLICT");

          const user = await admit(ctx.context.internalAdapter, claims);
          // `true`: don't remember me. A day from now, and not slid forward by using it.
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            true,
          );
          await setSessionCookie(ctx, { session, user }, true);
          const cookie = sessionCookieHeader(ctx.responseHeaders, [
            ctx.context.authCookies.sessionToken.name,
            ctx.context.authCookies.dontRememberToken.name,
          ]);
          ctx.responseHeaders?.delete("set-cookie");

          let deviceId: string;
          try {
            if (!cookie) throw new Error("The session cookie was not set.");
            ({ deviceId } = await linked({
              userId: user.id,
              sessionId: session.id,
              device: ctx.body.device,
              ...(ctx.body.previousDeviceId
                ? { previousDeviceId: ctx.body.previousDeviceId }
                : {}),
            }));
          } catch (error) {
            // A phone that could not be recorded cannot be listed or revoked, so it gets no session.
            await ctx.context.internalAdapter
              .deleteSession(session.token)
              .catch(() => undefined);
            console.error(
              JSON.stringify({
                type: "mobile-link-failed",
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            throw new APIError("NOT_FOUND", {
              code: "mobile_link_unavailable",
              message: "Linking a phone is not available on this deployment.",
            });
          }
          return ctx.json({
            cookie,
            deviceId,
            expiresAt: new Date(session.expiresAt).toISOString(),
            user: { id: user.id, email: user.email, name: user.name ?? null },
          } satisfies MobileLinkResponse);
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path) => path.startsWith("/signin-handoff"),
        window: 60,
        max: 10,
      },
    ],
  } satisfies BetterAuthPlugin;
}
