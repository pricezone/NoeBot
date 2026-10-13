import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { parseAriaSnapshot } from "../src/aria-snapshot";
import {
  MASKED_VALUE,
  maskSensitiveValues,
  SECRET_ATTRIBUTE,
  sensitiveRefs,
} from "../src/secret-masking";
import {
  fillSignIn,
  originOfUrl,
  parseSignInFill,
  probeSignIn,
} from "../src/sign-in";

/**
 * The computer's half of the private sign-in, against a real Chromium and a real login page served
 * on 127.0.0.1: the login is typed by this process, only on the origin it was meant for, and neither
 * the snapshot nor the answer ever shows the password back.
 *
 * The browser half is asked for by name, like `follows-popup.test.ts`: it launches a real Chromium,
 * which the machine running `bun test` is not required to have, so Playwright is imported only then.
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/sign-in.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const PASSWORD = "hunter2-not-for-the-model";
const CODE = "424242";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let origin = "";
let otherOrigin = "";

const page = (body: string) =>
  new Response(`<!doctype html><html><body>${body}</body></html>`, {
    headers: { "content-type": "text/html" },
  });

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/login")
        return page(`<form method="post" action="/session">
          <label>Email <input name="email" type="email"></label>
          <label>Password <input name="password" type="password"></label>
          <button>Sign in</button></form>`);
      if (url.pathname === "/session" && request.method === "POST") {
        const form = await request.formData();
        return form.get("password") === PASSWORD &&
          form.get("email") === "a@example.test"
          ? Response.redirect(`${origin}/home`, 303)
          : page(`<p>Wrong password</p><form method="post" action="/session">
              <input name="email" type="email"><input name="password" type="password"></form>`);
      }
      if (url.pathname === "/step-one")
        return page(`<form method="get" action="/step-two">
          <input name="username" autocomplete="username"><button>Next</button></form>`);
      if (url.pathname === "/step-two")
        return page(`<form method="post" action="/session">
          <input name="email" type="email" value="${url.searchParams.get("username") ?? ""}">
          <input name="password" type="password"></form>`);
      // No form at all: the button's own script sends the login, and Enter in a field does nothing.
      if (url.pathname === "/script-login")
        return page(`<div class="login">
          <label>Username <input id="username" name="username"></label>
          <label>Password <input id="password" name="password" type="password"></label>
          <button type="button" aria-label="Show password">👁</button>
          <button id="submit" class="btn" onclick="
            if (document.getElementById('password').value === '${PASSWORD}')
              location.href = '/home';
            else document.body.insertAdjacentHTML('beforeend', '<p>Wrong</p>');
          ">Submit</button></div>`);
      if (url.pathname === "/home") return page("<h1>Welcome back</h1>");
      // A confirmation code on a page of its own, after the login (gov.gr's SMS step).
      if (url.pathname === "/code")
        return page(`<form method="post" action="/code-check">
          <label>Κωδικός Επιβεβαίωσης <input name="otp" autocomplete="one-time-code"></label>
          <button>Επιβεβαίωση</button></form>`);
      if (url.pathname === "/code-check" && request.method === "POST") {
        const form = await request.formData();
        return form.get("otp") === CODE
          ? Response.redirect(`${origin}/home`, 303)
          : page(`<p>Wrong code</p>`);
      }
      // The service's description page: links and a "Sign in" button, no fields.
      if (url.pathname === "/service")
        return page(
          `<h1>Υπεύθυνη δήλωση</h1><a href="/login">Είσοδος στην υπηρεσία</a>`,
        );
      // The login inside a frame from another origin (a bank's or an identity provider's widget).
      if (url.pathname === "/framed")
        return page(
          `<h1>Sign in</h1><iframe src="${otherOrigin}/login" width="400" height="300"></iframe>`,
        );
      return new Response("not found", { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/login")
        return page(`<form method="post" action="/session">
          <input name="email" type="email" autocomplete="username">
          <input name="password" type="password"><button>Sign in</button></form>`);
      if (url.pathname === "/session" && request.method === "POST") {
        const form = await request.formData();
        return form.get("password") === PASSWORD
          ? page("<h1>Framed welcome</h1>")
          : page(`<p>Wrong</p>`);
      }
      return new Response("not found", { status: 404 });
    },
  });
  otherOrigin = `http://127.0.0.1:${other.port}`;
  if (!asked) return;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  other?.stop(true);
});

async function open(path: string): Promise<Page> {
  const tab = await browser.newPage();
  await tab.goto(`${origin}${path}`);
  return tab;
}

describe("parsing what the server sends", () => {
  test("refuses a body without an origin or password, and never quotes a value", () => {
    expect(parseSignInFill({ origin: "nope", password: PASSWORD })).toBe(
      "A sign-in names the website's origin.",
    );
    expect(parseSignInFill({ origin, password: "" })).toBe(
      "A sign-in needs a password, or a code for a page that asks for one alone.",
    );
    // A page that asks for a one-time code alone takes the code without a password.
    expect(parseSignInFill({ origin, code: CODE })).toEqual({
      origin,
      code: CODE,
    });
    expect(
      parseSignInFill({ origin: `${origin}/login`, password: PASSWORD }),
    ).toEqual({
      origin,
      password: PASSWORD,
    });
    expect(originOfUrl("about:blank")).toBe("");
  });
});

describe.skipIf(!asked)("typing a login", () => {
  test("fills and submits a one-step form, and reports only the outcome", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toEqual({
      submitted: true,
      passwordFieldVisible: false,
      url: `${origin}/home`,
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    await tab.close();
  });

  test("a rejected password leaves a password field showing, which is the failure signal", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: "wrong-one",
    });
    expect(result.submitted).toBe(true);
    expect(result.passwordFieldVisible).toBe(true);
    await tab.close();
  });

  test("follows a two-step login on the same origin", async () => {
    const tab = await open("/step-one");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({
      submitted: true,
      passwordFieldVisible: false,
    });
    expect(result.url).toBe(`${origin}/home`);
    await tab.close();
  });

  test("sends a login that no form wraps, through the button that does, never the show-password one", async () => {
    const tab = await open("/script-login");
    const result = await fillSignIn(tab, {
      origin,
      username: "student",
      password: PASSWORD,
    });
    expect(result).toEqual({
      submitted: true,
      passwordFieldVisible: false,
      url: `${origin}/home`,
    });
    await tab.close();
  });

  test("types nothing when the page is on another origin", async () => {
    const tab = await open("/login");
    const result = await fillSignIn(tab, {
      origin: "https://example.com",
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result.submitted).toBe(false);
    expect(result.error).toContain("not on https://example.com");
    expect(await tab.locator("input[type=password]").inputValue()).toBe("");
    await tab.close();
  });
});

describe.skipIf(!asked)("secrets typed into the page are not read back", () => {
  test("the aria snapshot shows a password's value, and the masked snapshot does not", async () => {
    const tab = await browser.newPage();
    await tab.setContent(`<form>
      <input aria-label="User" value="alice">
      <input aria-label="Password" type="password" value="${PASSWORD}">
      <input aria-label="API token" id="token" value="tok_live_abc123">
    </form>`);
    // Mark the token field the way a supplied secret is marked.
    await tab
      .locator("#token")
      .evaluate(
        (element, attribute) => element.setAttribute(attribute, "true"),
        SECRET_ATTRIBUTE,
      );
    const yaml = await tab.ariaSnapshot({ mode: "ai" });
    // The leak this guards against, confirmed rather than assumed.
    expect(yaml).toContain(PASSWORD);
    const { elements } = parseAriaSnapshot(yaml);
    const masked = maskSensitiveValues(
      elements,
      await sensitiveRefs(tab, elements),
    );
    const text = JSON.stringify(masked);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("tok_live_abc123");
    expect(text).toContain("alice");
    expect(
      masked.filter((element) => element.value === MASKED_VALUE),
    ).toHaveLength(2);
    await tab.close();
  });
});

describe.skipIf(!asked)(
  "looking before asking, and the pages a plain login form misses",
  () => {
    test("the probe tells a description page from a login, a code page and a framed login", async () => {
      const service = await open("/service");
      expect(await probeSignIn(service)).toMatchObject({
        origin,
        form: "none",
      });
      await service.close();
      const login = await open("/login");
      expect(await probeSignIn(login)).toMatchObject({ form: "login" });
      await login.close();
      const code = await open("/code");
      expect(await probeSignIn(code)).toMatchObject({ form: "code" });
      await code.close();
      const framed = await open("/framed");
      await framed.frames()[1]?.waitForLoadState();
      expect(await probeSignIn(framed)).toMatchObject({
        origin,
        form: "login",
      });
      await framed.close();
    });

    test("a code page takes the code alone, masked, and submits it", async () => {
      const tab = await open("/code");
      const result = await fillSignIn(tab, { origin, code: CODE });
      expect(result).toMatchObject({ submitted: true, url: `${origin}/home` });
      expect(JSON.stringify(result)).not.toContain(CODE);
      await tab.close();
    });

    test("a login inside a frame from another origin is filled there", async () => {
      const tab = await open("/framed");
      await tab.frames()[1]?.waitForLoadState();
      const result = await fillSignIn(tab, {
        origin,
        username: "a@example.test",
        password: PASSWORD,
      });
      expect(result.submitted).toBe(true);
      await tab.frames()[1]?.waitForLoadState();
      expect(await tab.frames()[1]?.textContent("body")).toContain(
        "Framed welcome",
      );
      await tab.close();
    });

    test("the username is marked secret too, so the next snapshot cannot read it back", async () => {
      const tab = await open("/script-login");
      // A wrong password keeps the page, so the filled username field is still there to inspect.
      await fillSignIn(tab, { origin, username: "student", password: "wrong" });
      expect(
        await tab.locator("#username").getAttribute(SECRET_ATTRIBUTE),
      ).not.toBeNull();
      await tab.close();
    });
  },
);
