import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { SECRET_ATTRIBUTE } from "../src/secret-masking";
import {
  classifySignInPage,
  fillSignIn,
  probeSignIn,
  SIGN_IN_WORDS,
  type SignInPageSummary,
  typeSecretValue,
} from "../src/sign-in";

/**
 * The private sign-in on the pages real sites draw, not one portal's: an OAuth window that closes
 * itself, a login inside a shadow root, a code in six boxes, a code field known only by its keyboard,
 * decoys that say "code" or "email" and are not a login, a username step that sends you to another
 * origin, and every way a page answers a submit (signed in, refused, a code next, an approval on the
 * phone, a security check).
 *
 * Real Chromium against pages served on 127.0.0.1, asked for by name like `sign-in.test.ts`:
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/sign-in-pages.test.ts
 *
 * The first block needs no browser.
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const PASSWORD = "hunter2-not-for-the-model";
const CODE = "424242";
let browser: Browser;
let site: ReturnType<typeof Bun.serve>;
let idp: ReturnType<typeof Bun.serve>;
let origin = "";
let idpOrigin = "";
/** What the last remember-device login sent for its checkbox. */
let rememberSent: string | null | undefined;

const html = (body: string) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const boxes = Array.from(
  { length: 6 },
  (_, index) =>
    `<input name="d${index}" maxlength="1" inputmode="numeric" aria-label="Digit ${index + 1}" style="width:2em">`,
).join("");

/** Six boxes that move the focus on, the way such pages do. */
const splitCode = (error = "") => `<form method="post" action="/split-check">
  ${error}<p>Enter the 6-digit code we sent you</p><div class="otp">${boxes}</div>
  <button>Verify</button></form>
  <script>
    const inputs = [...document.querySelectorAll('.otp input')];
    inputs.forEach((input, index) => input.addEventListener('input', () => {
      if (input.value && inputs[index + 1]) inputs[index + 1].focus();
    }));
  </script>`;

const login = (
  action: string,
  extra = "",
) => `<form method="post" action="${action}">
  <label>Email <input name="email" type="email"></label>
  <label>Password <input name="password" type="password"></label>
  ${extra}<button>Sign in</button></form>`;

beforeAll(async () => {
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const form =
        request.method === "POST" ? await request.formData() : undefined;
      switch (url.pathname) {
        case "/home":
          return html("<h1>Welcome back</h1>");
        // The site's own page, whose button opens the identity provider in a window.
        case "/app":
          return html(
            `<button id="oauth" onclick="window.open('${idpOrigin}/authorize','signin','width=500,height=600')">Continue with Example ID</button>`,
          );
        // Where the identity provider sends the window back: it tells its opener and closes itself.
        case "/callback":
          return html(
            `<p>Done</p><script>window.opener.location.href = '/dashboard'; window.close();</script>`,
          );
        case "/dashboard":
          return html("<h1>Your dashboard</h1>");
        // A login drawn inside an open shadow root, sent by its button's script.
        case "/shadow":
          return html(`<login-box></login-box><script>
            customElements.define('login-box', class extends HTMLElement {
              connectedCallback() {
                const root = this.attachShadow({ mode: 'open' });
                root.innerHTML = '<label>Email <input name="email" type="email"></label>' +
                  '<label>Password <input name="password" type="password"></label>' +
                  '<button type="button" aria-label="Show password">show</button>' +
                  '<button id="go">Sign in</button>';
                root.getElementById('go').onclick = () => {
                  if (root.querySelector('[name=password]').value === '${PASSWORD}') location.href = '/home';
                  else {
                    const alert = document.createElement('p');
                    alert.setAttribute('role', 'alert');
                    alert.textContent = 'That password is not right';
                    root.append(alert);
                  }
                };
              }
            });
          </script>`);
        case "/split":
          return html(splitCode());
        case "/split-check": {
          const typed = Array.from({ length: 6 }, (_, index) =>
            String(form?.get(`d${index}`) ?? ""),
          ).join("");
          return typed === CODE
            ? Response.redirect(`${origin}/home`, 303)
            : html(splitCode('<p class="error">Incorrect code</p>'));
        }
        // Known only by its keyboard and length: no name, no label that says "code".
        case "/numeric":
          return html(`<form method="post" action="/numeric-check">
            <p>Check your messages</p><input name="field_17" inputmode="numeric" maxlength="6">
            <button>OK</button></form>`);
        case "/numeric-check":
          return form?.get("field_17") === CODE
            ? Response.redirect(`${origin}/home`, 303)
            : html("<p>Wrong</p>");
        // Fields that say "code" and are nothing to do with a sign-in.
        case "/decoys":
          return html(`<form><label>Postcode <input name="postcode" inputmode="numeric" maxlength="5"></label>
            <label>Promo code <input name="promo"></label>
            <label>Gift card <input name="gift_code" maxlength="8" inputmode="numeric"></label>
            <button>Apply</button></form>`);
        case "/newsletter":
          return html(`<main><h1>Our shop</h1></main><footer>
            <form action="/subscribe"><p>Subscribe to our newsletter</p>
            <input type="email" name="email" placeholder="Your email"><button>Subscribe</button></form></footer>`);
        case "/newsletter-and-login":
          return html(`<form method="get" action="/step-two">
            <label>Email <input name="identifier" type="email"></label><button>Next</button></form>
            <footer><form action="/subscribe"><p>Get our newsletter</p>
            <input type="email" name="email"><button>Subscribe</button></form></footer>`);
        case "/step-two":
          return html(login("/session"));
        case "/session":
          return form?.get("password") === PASSWORD
            ? Response.redirect(`${origin}/home`, 303)
            : html(
                `<div role="alert">Incorrect email or password.</div>${login("/session")}`,
              );
        // A username here, the password on the identity provider's own origin.
        case "/xo-step-one":
          return html(`<form method="get" action="${idpOrigin}/password">
            <input name="username" autocomplete="username"><button>Next</button></form>`);
        // A username here, the password in a frame the next page embeds.
        case "/frame-step-one":
          return html(`<form method="get" action="/frame-step-two">
            <input name="username" autocomplete="username"><button>Next</button></form>`);
        case "/frame-step-two":
          return html(
            `<iframe src="${idpOrigin}/framed-password" width="500" height="300"></iframe>`,
          );
        case "/push":
          return html(login("/push-session"));
        case "/push-session":
          return html(`<h1>Check your phone</h1>
            <p>We sent a notification to your phone. Approve the sign-in on your phone to continue.</p>`);
        case "/remember":
          return html(
            login(
              "/remember-session",
              `<label><input type="checkbox" name="remember" checked> Remember this device</label>`,
            ),
          );
        case "/remember-session":
          rememberSent = form?.get("remember") as string | null;
          return Response.redirect(`${origin}/home`, 303);
        case "/captcha":
          return html(login("/captcha-session"));
        case "/captcha-session":
          return html(`<p>Please verify you are human to continue.</p>
            <label><input type="checkbox" aria-label="I'm not a robot"> I'm not a robot</label>`);
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  origin = `http://127.0.0.1:${site.port}`;
  idp = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const form =
        request.method === "POST" ? await request.formData() : undefined;
      switch (url.pathname) {
        case "/authorize":
          return html(login("/authorize-session"));
        case "/authorize-session":
          return form?.get("password") === PASSWORD
            ? Response.redirect(`${origin}/callback`, 303)
            : html(
                `<p role="alert">Wrong password</p>${login("/authorize-session")}`,
              );
        case "/password":
          return html(`<form method="post" action="/password-session">
            <input name="email" type="email" value="${url.searchParams.get("username") ?? ""}">
            <input name="password" type="password"><button>Sign in</button></form>`);
        case "/password-session":
          return form?.get("password") === PASSWORD
            ? html("<h1>Signed in at the identity provider</h1>")
            : html(`<p role="alert">Wrong password</p>`);
        case "/framed-password":
          return html(`<form method="post" action="/framed-session">
            <input name="password" type="password"><button>Sign in</button></form>`);
        case "/framed-session":
          return form?.get("password") === PASSWORD
            ? html("<h1>Framed welcome</h1>")
            : html(`<p role="alert">Wrong password</p>`);
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  idpOrigin = `http://127.0.0.1:${idp.port}`;
  if (!asked) return;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  site?.stop(true);
  idp?.stop(true);
});

async function open(path: string, at = origin): Promise<Page> {
  const tab = await browser.newPage();
  await tab.goto(`${at}${path}`);
  return tab;
}

const page = (summary: Partial<SignInPageSummary>): SignInPageSummary => ({
  username: false,
  password: false,
  code: false,
  messageIsError: false,
  messageFromAlert: false,
  approval: false,
  captcha: false,
  rememberDevice: false,
  ...summary,
});

describe("reading the answer to a submit", () => {
  test("a wrong code stays wrong, with or without the form", () => {
    expect(
      classifySignInPage(page({ code: true, message: "Wrong" }), "code"),
    ).toEqual({ outcome: "error", pageMessage: "Wrong" });
    expect(
      classifySignInPage(
        page({ message: "That code is invalid", messageIsError: true }),
        "code",
      ),
    ).toEqual({ outcome: "error", pageMessage: "That code is invalid" });
  });

  test("a new code box asks for the code, even beside a note that is no error", () => {
    expect(
      classifySignInPage(
        page({ code: true, message: "We sent a code", messageFromAlert: true }),
        "login",
      ),
    ).toEqual({ outcome: "code-requested" });
  });

  test("a security check wins, an approval page waits, and a page with no form is signed in", () => {
    expect(
      classifySignInPage(page({ captcha: true, password: true }), "login"),
    ).toEqual({ outcome: "captcha" });
    expect(classifySignInPage(page({ approval: true }), "login")).toEqual({
      outcome: "push-approval",
    });
    expect(classifySignInPage(page({}), "login")).toEqual({
      outcome: "signed-in",
    });
    expect(classifySignInPage(page({ password: true }), "login")).toEqual({
      outcome: "error",
    });
  });

  test("the word lists read many languages and leave out what is not a sign-in code", () => {
    const code = new RegExp(SIGN_IN_WORDS.code, "i");
    const notCode = new RegExp(SIGN_IN_WORDS.notCode, "i");
    for (const label of [
      "Verification code",
      "Κωδικός επιβεβαίωσης",
      "Código de verificación",
      "Bestätigungscode",
      "codice di verifica",
      "kod weryfikacyjny",
      "код подтверждения",
      "認証コード",
      "验证码",
      "otp",
      "user_otp",
      "2FA",
      "PIN",
    ])
      expect(code.test(label)).toBe(true);
    for (const label of [
      "Postcode",
      "ZIP code",
      "Promo code",
      "coupon",
      "voucher code",
      "discount code",
      "gift card code",
      "código postal",
    ])
      expect(notCode.test(label)).toBe(true);
    expect(code.test("spinner")).toBe(false);
  });
});

describe.skipIf(!asked)("pages the plain login form missed", () => {
  test("an OAuth window that closes itself after the login is followed back to the site", async () => {
    const app = await open("/app");
    const [popup] = await Promise.all([
      app.context().waitForEvent("page"),
      app.click("#oauth"),
    ]);
    await popup.waitForLoadState();
    expect(await probeSignIn(popup)).toMatchObject({
      origin: idpOrigin,
      form: "login",
    });
    const result = await fillSignIn(popup, {
      origin: idpOrigin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(popup.isClosed()).toBe(true);
    expect(result).toMatchObject({
      submitted: true,
      outcome: "signed-in",
      url: `${origin}/dashboard`,
    });
    expect(result.error).toBeUndefined();
    await app.close();
  });

  test("a login inside an open shadow root is found, filled and sent by its own button", async () => {
    const tab = await open("/shadow");
    expect(await probeSignIn(tab)).toMatchObject({ form: "login" });
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({
      submitted: true,
      outcome: "signed-in",
      url: `${origin}/home`,
    });
    await tab.close();
  });

  test("a wrong password inside a shadow root is an error with the site's words", async () => {
    const tab = await open("/shadow");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: "nope",
    });
    expect(result).toMatchObject({
      outcome: "error",
      pageMessage: "That password is not right",
    });
    await tab.close();
  });

  test("a code in six boxes is typed one box at a time", async () => {
    const tab = await open("/split");
    expect(await probeSignIn(tab)).toMatchObject({ form: "code" });
    const result = await fillSignIn(tab, { origin, code: CODE });
    expect(result).toMatchObject({
      submitted: true,
      outcome: "signed-in",
      url: `${origin}/home`,
    });
    expect(JSON.stringify(result)).not.toContain(CODE);
    await tab.close();
  });

  test("a wrong code in six boxes comes back as wrong", async () => {
    const tab = await open("/split");
    const result = await fillSignIn(tab, { origin, code: "111111" });
    expect(result).toMatchObject({
      outcome: "error",
      pageMessage: "Incorrect code",
    });
    await tab.close();
  });

  test("one value for one of six boxes, the way a person answers a secret request, fills the row", async () => {
    const tab = await open("/split");
    await typeSecretValue(tab, tab.locator("input[name=d0]"), CODE, 5_000);
    const values = await tab
      .locator(".otp input")
      .evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value).join(""),
      );
    expect(values).toBe(CODE);
    expect(
      await tab.locator("input[name=d5]").getAttribute(SECRET_ATTRIBUTE),
    ).not.toBeNull();
    await tab.close();
  });

  test("a code field known only by its numeric keyboard and length is a code field", async () => {
    const tab = await open("/numeric");
    expect(await probeSignIn(tab)).toMatchObject({ form: "code" });
    const result = await fillSignIn(tab, { origin, code: CODE });
    expect(result).toMatchObject({ outcome: "signed-in" });
    await tab.close();
  });

  test("a postcode, a promo code and a gift card are not a sign-in", async () => {
    const tab = await open("/decoys");
    expect(await probeSignIn(tab)).toMatchObject({ form: "none" });
    expect((await fillSignIn(tab, { origin, code: CODE })).error).toBeDefined();
    await tab.close();
  });

  test("a newsletter box is not the first step of a login", async () => {
    const shop = await open("/newsletter");
    expect(await probeSignIn(shop)).toMatchObject({ form: "none" });
    await shop.close();
    const tab = await open("/newsletter-and-login");
    expect(await probeSignIn(tab)).toMatchObject({ form: "username" });
    expect(
      await tab.locator('[data-openbot-login="username"]').getAttribute("name"),
    ).toBe("identifier");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({ outcome: "signed-in" });
    await tab.close();
  });
});

describe.skipIf(!asked)("two steps", () => {
  test("a password page on another origin is reported, untouched, for the server to continue", async () => {
    const tab = await open("/xo-step-one");
    const moved = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(moved).toMatchObject({
      submitted: true,
      movedTo: { origin: idpOrigin, form: "login" },
    });
    expect(moved.error).toBeUndefined();
    expect(await tab.locator("input[type=password]").inputValue()).toBe("");
    // The server continues on the identity provider's origin with the same login.
    const result = await fillSignIn(tab, {
      origin: idpOrigin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({ outcome: "signed-in" });
    expect(await tab.textContent("h1")).toContain("identity provider");
    await tab.close();
  });

  test("a password step drawn inside a frame is waited for in the frame", async () => {
    const tab = await open("/frame-step-one");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({ submitted: true, outcome: "signed-in" });
    expect(await tab.frames()[1]?.textContent("h1")).toBe("Framed welcome");
    await tab.close();
  });
});

describe.skipIf(!asked)("what the page says after the login", () => {
  test("a wrong password is an error, quoting the site's alert", async () => {
    const tab = await open("/step-two");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: "wrong",
    });
    expect(result).toMatchObject({
      outcome: "error",
      pageMessage: "Incorrect email or password.",
    });
    await tab.close();
  });

  test("an approval waited for on the phone is push-approval, and the probe sees it end", async () => {
    const tab = await open("/push");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({ outcome: "push-approval" });
    expect((await probeSignIn(tab)).check).toEqual({
      outcome: "push-approval",
    });
    // Approved on the phone: the site moves on.
    await tab.goto(`${origin}/home`);
    expect((await probeSignIn(tab)).check).toEqual({ outcome: "signed-in" });
    await tab.close();
  });

  test("a remember-this-device box is left unchecked, and the answer says so", async () => {
    rememberSent = undefined;
    const tab = await open("/remember");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({
      outcome: "signed-in",
      rememberDeviceLeftUnchecked: true,
    });
    expect(rememberSent).toBeNull();
    await tab.close();
  });

  test("a security check after the login is captcha, for a person to pass", async () => {
    const tab = await open("/captcha");
    const result = await fillSignIn(tab, {
      origin,
      username: "a@example.test",
      password: PASSWORD,
    });
    expect(result).toMatchObject({ submitted: true, outcome: "captcha" });
    await tab.close();
  });
});
