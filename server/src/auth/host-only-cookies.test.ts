import { describe, expect, test } from "bun:test";
import { getCookies } from "better-auth/cookies";

import { HOST_ONLY_COOKIE_PREFIX, hostOnlyCookies } from "./index";

describe("host-only session cookies", () => {
  test("make every session cookie a __Host- cookie over https", () => {
    const cookies = getCookies({
      baseURL: "https://abcd1234.hypernoesis.app",
      ...hostOnlyCookies("https://abcd1234.hypernoesis.app"),
    });
    for (const cookie of [
      cookies.sessionToken,
      cookies.sessionData,
      cookies.dontRememberToken,
    ]) {
      expect(cookie.name.startsWith(`${HOST_ONLY_COOKIE_PREFIX}.`)).toBe(true);
      // What a browser demands of a __Host- cookie: Secure, Path=/ and no Domain.
      expect(cookie.attributes.secure).toBe(true);
      expect(cookie.attributes.path).toBe("/");
      expect(
        "domain" in cookie.attributes && cookie.attributes.domain,
      ).toBeFalsy();
    }
    expect(cookies.sessionToken.name).toBe("__Host-better-auth.session_token");
  });

  test("leave plain-http development alone, since __Host- needs https", () => {
    expect(hostOnlyCookies("http://localhost:3001")).toEqual({});
    expect(hostOnlyCookies(undefined)).toEqual({});
    const cookies = getCookies({
      baseURL: "http://localhost:3001",
      ...hostOnlyCookies("http://localhost:3001"),
    });
    expect(cookies.sessionToken.name).toBe("better-auth.session_token");
  });
});
