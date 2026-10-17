import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { MOBILE_LINK_AUDIENCE } from "../../shared/mobile-link";
import {
  type SignInHandoffClaims,
  sessionCookieHeader,
  verifySignInHandoffToken,
} from "../src/auth/signin-handoff";
import { viewerClick } from "../src/clicky/index";
import {
  sessionCookieName,
  sessionTokenFromCookies,
} from "../src/mobile/store";

/*
 * The parts of linking a phone that need no database: the audience claim on a token, the Cookie
 * header the phone is handed, and finding which phone a request came from. The endpoints themselves,
 * end to end, are in clicky-pairing.integration.test.ts.
 */

const secret = "s".repeat(48);
const now = Date.parse("2026-10-14T12:00:00Z");

function mint(claims: Partial<SignInHandoffClaims> & Record<string, unknown>) {
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: "owner@example.com",
      iid: "abcdefghijkl",
      iat,
      exp: iat + 60,
      jti: "one",
      ...claims,
    }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

describe("the audience claim", () => {
  test("a phone's token carries aud mobile, a browser's none", () => {
    expect(
      verifySignInHandoffToken(mint({ aud: MOBILE_LINK_AUDIENCE }), secret, {
        now,
      })?.aud,
    ).toBe("mobile");
    expect(verifySignInHandoffToken(mint({}), secret, { now })?.aud).toBe(
      undefined,
    );
  });

  test("a token minted to live longer than two minutes is not one the platform mints", () => {
    const iat = Math.floor(now / 1000);
    expect(
      verifySignInHandoffToken(mint({ iat, exp: iat + 120 }), secret, { now }),
    ).not.toBeNull();
    expect(
      verifySignInHandoffToken(mint({ iat, exp: iat + 121 }), secret, { now }),
    ).toBeNull();
    expect(
      verifySignInHandoffToken(mint({ iat, exp: iat + 86_400 }), secret, {
        now,
      }),
    ).toBeNull();
  });

  test("an audience that is not a string makes the token unreadable", () => {
    expect(verifySignInHandoffToken(mint({ aud: 7 }), secret, { now })).toBe(
      null,
    );
  });
});

describe("sessionCookieHeader", () => {
  test("names both cookies with their values exactly as they were set", () => {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "__Host-better-auth.session_token=tok.sig%3D; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    headers.append(
      "set-cookie",
      "__Host-better-auth.dont_remember=true.sig2%3D; Path=/; HttpOnly; Secure; SameSite=Lax",
    );
    headers.append("set-cookie", "other=1; Path=/");
    expect(
      sessionCookieHeader(headers, [
        "__Host-better-auth.session_token",
        "__Host-better-auth.dont_remember",
      ]),
    ).toBe(
      "__Host-better-auth.session_token=tok.sig%3D; __Host-better-auth.dont_remember=true.sig2%3D",
    );
  });

  test("is nothing at all when either cookie is missing", () => {
    const headers = new Headers();
    headers.append("set-cookie", "better-auth.session_token=a.b; Path=/");
    expect(
      sessionCookieHeader(headers, [
        "better-auth.session_token",
        "better-auth.dont_remember",
      ]),
    ).toBeNull();
    expect(sessionCookieHeader(undefined, ["x"])).toBeNull();
  });
});

describe("sessionTokenFromCookies", () => {
  test("reads exactly this deployment's session cookie, its signature taken off", () => {
    const name = sessionCookieName("https://abcdefghijkl.hypernoesis.app");
    expect(name).toBe("__Host-better-auth.session_token");
    expect(sessionCookieName("http://127.0.0.1:3000")).toBe(
      "better-auth.session_token",
    );
    expect(
      sessionTokenFromCookies(
        "theme=dark; __Host-better-auth.session_token=abc123.c2lnbmF0dXJl%3D; x=y",
        name,
      ),
    ).toBe("abc123");
    expect(
      sessionTokenFromCookies(
        "better-auth.session_token=plain.sig",
        "better-auth.session_token",
      ),
    ).toBe("plain");
    expect(sessionTokenFromCookies("theme=dark", name)).toBeNull();
    expect(sessionTokenFromCookies(undefined, name)).toBeNull();
  });

  test("a look-alike cookie, such as one a sibling set for the parent domain, is not it", () => {
    const name = "__Host-better-auth.session_token";
    expect(
      sessionTokenFromCookies(
        "evil.better-auth.session_token=forged.sig; better-auth.session_token=other.sig",
        name,
      ),
    ).toBeNull();
    expect(
      sessionTokenFromCookies(
        "better-auth.session_token=other.sig; __Host-better-auth.session_token=mine.sig",
        name,
      ),
    ).toBe("mine");
  });
});

describe("viewerClick", () => {
  test("a click on the live screen is its release, as a fraction of the frame", () => {
    expect(
      viewerClick(
        JSON.stringify({
          type: "mouse",
          event: "released",
          x: 720,
          y: 225,
          button: "left",
        }),
        { width: 1440, height: 900 },
      ),
    ).toEqual({ x: 0.5, y: 0.25 });
  });

  test("anything else is ignored, and so is a click with no frame to place it on", () => {
    const frame = { width: 1440, height: 900 };
    expect(
      viewerClick(
        JSON.stringify({ type: "mouse", event: "moved", x: 1, y: 1 }),
        frame,
      ),
    ).toBeNull();
    // The button going down is not the click yet.
    expect(
      viewerClick(
        JSON.stringify({ type: "mouse", event: "pressed", x: 1, y: 1 }),
        frame,
      ),
    ).toBeNull();
    expect(
      viewerClick(
        JSON.stringify({ type: "key", event: "down", key: "pressed" }),
        frame,
      ),
    ).toBeNull();
    expect(
      viewerClick(
        JSON.stringify({ type: "mouse", event: "released", x: 1, y: 1 }),
        undefined,
      ),
    ).toBeNull();
    expect(viewerClick('{"type":"mouse","event":"released"', frame)).toBeNull();
  });
});
