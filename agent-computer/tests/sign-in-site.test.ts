import { expect, test } from "bun:test";
import {
  sameSite as serverSameSite,
  TENANT_DOMAINS as SERVER_TENANTS,
} from "../../server/src/passwords/site";
import { sameSite, TENANT_DOMAINS } from "../src/site";

/**
 * The computer keeps its own copy of the same-site rule (it is its own package and image). It must
 * never drift from the server's: the computer decides whether a framed login may be typed at all,
 * the server whether a moved login may follow, and both mean the same thing by "the same site".
 */
test("the computer's same-site rule is the server's", () => {
  expect(TENANT_DOMAINS).toEqual(SERVER_TENANTS);
  for (const [first, second] of [
    ["https://www.example.com", "https://login.example.com"],
    ["https://shop.example", "https://idp.example.net"],
    ["https://acme.okta.com", "https://evil.okta.com"],
    ["https://a.s3.amazonaws.com", "https://b.s3.amazonaws.com"],
    ["http://127.0.0.1:1", "http://127.0.0.1:2"],
    ["http://www.shop.test:1", "http://login.shop.test:2"],
  ] as const)
    expect(sameSite(first, second)).toBe(serverSameSite(first, second));
});
