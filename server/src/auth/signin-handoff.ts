import { createHmac, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

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
};

/** How far ahead of this clock an `iat` may sit before the token is refused as not yet valid. */
const CLOCK_SKEW_SECONDS = 30;

function isClaims(value: unknown): value is SignInHandoffClaims {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sub === "string" &&
    typeof record.iid === "string" &&
    typeof record.iat === "number" &&
    typeof record.exp === "number" &&
    typeof record.jti === "string"
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

export type SignInHandoffOptions = {
  secret: string;
  /** The one address a token may sign in, compared case-insensitively. */
  email: string;
  /** This deployment's id; a token for another one is refused. Unset skips that check. */
  deploymentId?: string;
};

/**
 * The Better Auth plugin: one GET endpoint at `/signin-handoff` under the auth base path.
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

  return {
    id: "signin-handoff",
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
          if (claims.sub.trim().toLowerCase() !== admitted) {
            return refuse("handoff_refused");
          }
          if (!remember(claims)) return refuse("handoff_replayed");

          const existing =
            await ctx.context.internalAdapter.findUserByEmail(admitted);
          const user =
            existing?.user ??
            (await ctx.context.internalAdapter.createUser(
              {
                email: admitted,
                emailVerified: true,
                name: admitted.split("@")[0] ?? admitted,
              },
              { method: "signin-handoff" },
            ));

          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          await setSessionCookie(ctx, { session, user });

          throw ctx.redirect(
            localRedirect(ctx.query.redirect, new URL(ctx.context.baseURL)),
          );
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
