import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  localRedirect,
  type SignInHandoffClaims,
  verifySignInHandoffToken,
} from "../src/auth/signin-handoff";

const secret = "s".repeat(48);
const now = Date.parse("2026-10-05T12:00:00Z");

/** Mint the way the platform does: base64url(JSON claims) + "." + base64url(HMAC-SHA256). */
function mint(claims: Partial<SignInHandoffClaims>, key = secret): string {
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
  const signature = createHmac("sha256", key)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

describe("verifySignInHandoffToken", () => {
  test("accepts a fresh token signed with the secret for this deployment", () => {
    const claims = verifySignInHandoffToken(mint({}), secret, {
      deploymentId: "abcdefghijkl",
      now,
    });
    expect(claims?.sub).toBe("owner@example.com");
    expect(claims?.jti).toBe("one");
  });

  test("refuses a wrong secret, a tampered payload and a malformed token", () => {
    expect(
      verifySignInHandoffToken(mint({}, "t".repeat(48)), secret, { now }),
    ).toBeNull();
    const [payload, signature] = mint({}).split(".");
    const tampered = `${Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? "", "base64url").toString()),
        sub: "intruder@example.com",
      }),
    ).toString("base64url")}.${signature}`;
    expect(verifySignInHandoffToken(tampered, secret, { now })).toBeNull();
    expect(verifySignInHandoffToken("", secret, { now })).toBeNull();
    expect(verifySignInHandoffToken("nodot", secret, { now })).toBeNull();
    expect(verifySignInHandoffToken(undefined, secret, { now })).toBeNull();
  });

  test("refuses an expired token and one from the far future", () => {
    expect(
      verifySignInHandoffToken(mint({}), secret, { now: now + 61_000 }),
    ).toBeNull();
    const iat = Math.floor(now / 1000) + 600;
    expect(
      verifySignInHandoffToken(mint({ iat, exp: iat + 60 }), secret, { now }),
    ).toBeNull();
  });

  test("refuses a token minted for another deployment, and ignores the id when this one has none", () => {
    expect(
      verifySignInHandoffToken(mint({ iid: "other" }), secret, {
        deploymentId: "abcdefghijkl",
        now,
      }),
    ).toBeNull();
    expect(
      verifySignInHandoffToken(mint({ iid: "other" }), secret, { now }),
    ).not.toBeNull();
  });
});

describe("localRedirect", () => {
  const base = new URL("https://abcdefghijkl.fly.dev/api/auth");

  test("keeps a path on this deployment, with its query and hash", () => {
    expect(localRedirect("/admin/audit?tab=1#top", base)).toBe(
      "/admin/audit?tab=1#top",
    );
    expect(localRedirect("/", base)).toBe("/");
  });

  test("sends anything that could leave this origin to the root", () => {
    for (const value of [
      undefined,
      "",
      "bots",
      "//evil.example",
      "/\\evil.example",
      "/\\/evil.example",
      "https://evil.example/",
      "/bots\u0000",
      "/bots\r\nLocation: https://evil.example",
    ]) {
      expect(localRedirect(value, base)).toBe("/");
    }
  });
});
