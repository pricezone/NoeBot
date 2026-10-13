/**
 * Typing a person's login into the Bot's page, on this side of the wire.
 *
 * The private sign-in form posts a username and password to the server, the server posts them here,
 * and this types them. The Bot is never involved: it does not pick the fields, it does not see the
 * values, and what comes back says only whether a form was submitted and whether a password field is
 * still showing.
 *
 * Before a person is shown the form at all, `probeSignIn` says what the page actually asks for (a
 * login, a username alone, a one-time code, or nothing), on which origin, and with which icon, so
 * the form names the real site and is never offered for a page that has no form on it.
 *
 * Three refusals, before anything is typed:
 *  - the page must be on the exact origin the person was asked to sign in to, so a login cannot be
 *    carried to a page that redirected somewhere else (or that the Bot navigated to afterwards);
 *  - there must be a login form on it;
 *  - a two-step login that moves to another origin between the username and password (an identity
 *    provider, say) is not followed: the person is asked to take over instead.
 *
 * Every failure is one of this module's own sentences. A Playwright error can quote the call it was
 * making, and this call's arguments are a password.
 */
import type { Frame, Locator, Page } from "playwright";
import { markElementSecret, SECRET_ATTRIBUTE } from "./secret-masking";

export type SignInFillInput = {
  origin: string;
  username?: string;
  /** Absent for a page that asks for a one-time code alone. */
  password?: string;
  code?: string;
};

/** What the page the Bot has open asks for, read before the person is shown a form. */
export type SignInProbe = {
  url: string;
  origin: string;
  host: string;
  form: "login" | "username" | "code" | "none";
  /** The site's icon as a small data URL, read through the Bot's own browser. */
  icon?: string;
};

export type SignInFillResult = {
  submitted: boolean;
  passwordFieldVisible: boolean;
  url: string;
  error?: string;
};

const LOGIN_ATTRIBUTE = "data-openbot-login";
const STEP_TIMEOUT_MS = 15_000;

/** The origin of a URL, or empty for one that has none (`about:blank`). */
export function originOfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : "";
  } catch {
    return "";
  }
}

/** Parse the body the server sends, without ever putting a value in an error. */
export function parseSignInFill(body: unknown): SignInFillInput | string {
  if (!body || typeof body !== "object") return "A sign-in needs a JSON body.";
  const input = body as Record<string, unknown>;
  if (typeof input.origin !== "string" || !originOfUrl(input.origin))
    return "A sign-in names the website's origin.";
  if (input.password !== undefined && typeof input.password !== "string")
    return "The password must be text.";
  if (input.username !== undefined && typeof input.username !== "string")
    return "The username must be text.";
  if (input.code !== undefined && typeof input.code !== "string")
    return "The code must be text.";
  if (!input.password && !input.code)
    return "A sign-in needs a password, or a code for a page that asks for one alone.";
  return {
    origin: originOfUrl(input.origin),
    ...(input.password ? { password: input.password } : {}),
    ...(input.username ? { username: input.username } : {}),
    ...(input.code ? { code: input.code } : {}),
  };
}

/**
 * Find the login fields on the page and mark them for the locators below.
 *
 * Runs in the page. A password field is any visible `input[type=password]`; the username is the
 * visible text-like input before it in the same form, preferring one the site labels as a username or
 * email. With no password field, a lone username field is the first step of a two-step login.
 */
function markLoginFields(attribute: string) {
  for (const node of document.querySelectorAll(`[${attribute}]`))
    node.removeAttribute(attribute);
  const visible = (element: Element) => {
    const input = element as HTMLInputElement;
    const box = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      !input.disabled &&
      !input.readOnly
    );
  };
  const passwords = [
    ...document.querySelectorAll<HTMLInputElement>("input[type=password]"),
  ].filter(visible);
  const password =
    passwords.find((input) => /current-password/.test(input.autocomplete)) ??
    passwords[0];
  const scope: ParentNode = password?.form ?? document;
  const textLike = [
    ...scope.querySelectorAll<HTMLInputElement>("input"),
  ].filter(
    (input) =>
      ["text", "email", "tel", ""].includes(input.type) &&
      visible(input) &&
      (!password ||
        Boolean(
          input.compareDocumentPosition(password) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        )),
  );
  const named = (input: HTMLInputElement) =>
    /username|email/.test(input.autocomplete) ||
    input.type === "email" ||
    /user|email|login|account|identifier/i.test(
      `${input.name} ${input.id} ${input.getAttribute("aria-label") ?? ""}`,
    );
  const username =
    textLike.filter(named).at(-1) ?? (password ? textLike.at(-1) : undefined);
  if (username) username.setAttribute(attribute, "username");
  if (password) password.setAttribute(attribute, "password");
  return { username: Boolean(username), password: Boolean(password) };
}

/** Find a one-time-code field. Runs in the page. */
function markCodeField(attribute: string) {
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>("input"),
  ].filter((input) => {
    const box = input.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      !input.disabled &&
      input.type !== "hidden"
    );
  });
  const code =
    inputs.find((input) => /one-time-code/.test(input.autocomplete)) ??
    inputs.find((input) =>
      /code|otp|totp|2fa|mfa|verif|token/i.test(`${input.name} ${input.id}`),
    );
  if (code) code.setAttribute(attribute, "code");
  return Boolean(code);
}

/**
 * How a form is sent, decided in the page: its own submit button when it has one, the form itself
 * when it has none (a form with several fields and no button ignores Enter), and Enter otherwise.
 *
 * A login no form wraps is sent by a script on its button, and Enter in a field goes nowhere: the
 * login was typed, nothing sent it, and the person was told it "was probably not accepted". So with no
 * form, the button is found the way a person finds it: the nearest one around the field that says it
 * sends the login, never one that shows the password or signs in somewhere else. Enter only when
 * there is no such button. Self-contained, because it runs in the page.
 */
function markSubmit(
  field: Element,
  attribute: string,
): "button" | "form" | "key" {
  const form = (field as HTMLInputElement).form;
  if (form) {
    const button = form.querySelector(
      "button:not([type=button]):not([type=reset]), input[type=submit]",
    );
    if (button) {
      button.setAttribute(attribute, "submit");
      return "button";
    }
    return "form";
  }
  const sends =
    /log\s?in|sign\s?in|submit|continue|next|σύνδεση|είσοδος|συνέχεια/i;
  const elsewhere =
    /show|hide|reveal|forgot|google|apple|facebook|microsoft|github|sso|εμφάνιση|απόκρυψη/i;
  const label = (element: Element) =>
    [
      element.textContent,
      (element as HTMLInputElement).value,
      element.id,
      element.getAttribute("name"),
      element.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");
  const usable = (element: Element) => {
    const box = element.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      !(element as HTMLButtonElement).disabled &&
      !elsewhere.test(label(element))
    );
  };
  let scope = field.parentElement;
  for (let depth = 0; scope && depth < 6; depth++) {
    const candidates = [
      ...scope.querySelectorAll(
        "button, input[type=submit], input[type=button], [role=button]",
      ),
    ].filter(usable);
    const chosen =
      candidates.find(
        (element) =>
          element.getAttribute("type") === "submit" &&
          element.tagName === "INPUT",
      ) ?? candidates.find((element) => sends.test(label(element)));
    if (chosen) {
      chosen.setAttribute(attribute, "submit");
      return "button";
    }
    scope = scope.parentElement;
  }
  return "key";
}

async function submitFrom(frame: Frame, field: Locator) {
  const how = await field.evaluate(markSubmit, LOGIN_ATTRIBUTE);
  if (how === "button")
    await frame
      .locator(`[${LOGIN_ATTRIBUTE}="submit"]`)
      .click({ timeout: STEP_TIMEOUT_MS });
  else if (how === "form")
    await field.evaluate((element) =>
      (element as HTMLInputElement).form?.requestSubmit(),
    );
  else await field.press("Enter", { timeout: STEP_TIMEOUT_MS });
}

async function settle(page: Page) {
  await page.waitForTimeout(800);
  await page
    .waitForLoadState("load", { timeout: STEP_TIMEOUT_MS })
    .catch(() => undefined);
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
}

async function passwordVisible(page: Page) {
  return (await page.locator("input[type=password]:visible").count()) > 0;
}

/**
 * The frame that holds the form, the main frame first.
 *
 * A login is often in the page itself and sometimes in a frame the page embeds (a bank's or an
 * identity provider's widget), so every frame is asked in turn, with the page's own marker run in
 * each. Frames that refuse to be evaluated (still loading, gone) are skipped.
 */
async function frameWith<T extends { found: boolean }>(
  page: Page,
  ask: (frame: Frame) => Promise<T>,
): Promise<{ frame: Frame; answer: T } | null> {
  const main = page.mainFrame();
  for (const frame of [main, ...page.frames().filter((f) => f !== main)]) {
    try {
      const answer = await ask(frame);
      if (answer.found) return { frame, answer };
    } catch {
      // A frame mid-navigation or detached: not this one.
    }
  }
  return null;
}

const loginIn = (frame: Frame) =>
  frame.evaluate(markLoginFields, LOGIN_ATTRIBUTE).then((marked) => ({
    ...marked,
    found: marked.password || marked.username,
  }));

const codeIn = (frame: Frame) =>
  frame.evaluate(markCodeField, LOGIN_ATTRIBUTE).then((found) => ({ found }));

/**
 * The page's icon, small, as a data URL, fetched by the Bot's own browser (so through its own egress
 * and never by the server). Anything that is not a small image is no icon.
 */
async function pageIcon(page: Page): Promise<string | undefined> {
  try {
    const href = await page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>(
        'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
      );
      return link?.href || new URL("/favicon.ico", location.origin).href;
    });
    if (!/^https?:/.test(href)) return undefined;
    const response = await page.request.get(href, {
      timeout: 4_000,
      maxRedirects: 3,
    });
    if (!response.ok()) return undefined;
    const type =
      (response.headers()["content-type"] ?? "").split(";")[0]?.trim() ?? "";
    if (
      !/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp)$/.test(
        type,
      )
    )
      return undefined;
    const body = await response.body();
    if (body.length === 0 || body.length > 32_768) return undefined;
    return `data:${type};base64,${body.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** What the Bot's page asks for right now. Reads and marks fields; types nothing. */
export async function probeSignIn(page: Page): Promise<SignInProbe> {
  const url = page.url();
  const origin = originOfUrl(url);
  let host = "";
  try {
    host = origin ? new URL(origin).host : "";
  } catch {
    host = "";
  }
  const login = await frameWith(page, loginIn);
  const form: SignInProbe["form"] = login
    ? login.answer.password
      ? "login"
      : "username"
    : (await frameWith(page, codeIn))
      ? "code"
      : "none";
  const icon = origin ? await pageIcon(page) : undefined;
  return { url, origin, host, form, ...(icon ? { icon } : {}) };
}

async function typeSecret(field: Locator, value: string) {
  await field.fill(value, { timeout: STEP_TIMEOUT_MS });
  await field.evaluate(markElementSecret, SECRET_ATTRIBUTE);
}

export async function fillSignIn(
  page: Page,
  input: SignInFillInput,
): Promise<SignInFillResult> {
  const answer = (error: string, submitted = false): SignInFillResult => ({
    submitted,
    passwordFieldVisible: false,
    url: page.url(),
    error,
  });
  if (originOfUrl(page.url()) !== input.origin)
    return answer(
      `The Bot's browser is not on ${input.origin}. Ask it to open that site's sign-in page and try again.`,
    );
  try {
    if (!input.password) {
      // A one-time code on a page of its own, sent after the login (an SMS confirmation, say).
      const code = await frameWith(page, codeIn);
      if (!code)
        return answer("There is no code field on the page the Bot has open.");
      const codeField = code.frame.locator(`[${LOGIN_ATTRIBUTE}="code"]`);
      await typeSecret(codeField, input.code ?? "");
      await submitFrom(code.frame, codeField);
      await settle(page);
      return {
        submitted: true,
        passwordFieldVisible: await passwordVisible(page),
        url: page.url(),
      };
    }
    let login = await frameWith(page, loginIn);
    if (!login)
      return answer("There is no sign-in form on the page the Bot has open.");
    let frame = login.frame;
    const usernameField = () =>
      frame.locator(`[${LOGIN_ATTRIBUTE}="username"]`);
    // Masked like the password: "never shown to your Bot" covers the username too, and a username
    // field is not a type the snapshot hides on its own.
    if (login.answer.username && input.username)
      await typeSecret(usernameField(), input.username);
    if (!login.answer.password) {
      // Two steps: username first, then the site shows the password field.
      if (!input.username)
        return answer(
          "This site asks for a username first. Enter one and try again.",
        );
      await submitFrom(frame, usernameField());
      await page
        .locator("input[type=password]:visible")
        .first()
        .waitFor({ timeout: STEP_TIMEOUT_MS })
        .catch(() => undefined);
      if (originOfUrl(page.url()) !== input.origin)
        return answer(
          `The sign-in moved to ${originOfUrl(page.url()) || "another page"}. Take over the browser to finish signing in there.`,
          true,
        );
      login = await frameWith(page, loginIn);
      if (!login?.answer.password)
        return answer(
          "The site did not ask for a password after the username.",
          true,
        );
      frame = login.frame;
    }
    const passwordField = frame.locator(`[${LOGIN_ATTRIBUTE}="password"]`);
    await typeSecret(passwordField, input.password);
    await submitFrom(frame, passwordField);
    await settle(page);
    if (input.code) {
      if (originOfUrl(page.url()) !== input.origin)
        return answer(
          `The sign-in moved to ${originOfUrl(page.url()) || "another page"} before the code was asked for. Take over the browser to finish.`,
          true,
        );
      let code = await frameWith(page, codeIn);
      if (!code) {
        await page.waitForTimeout(2_000);
        code = await frameWith(page, codeIn);
      }
      if (code) {
        const codeField = code.frame.locator(`[${LOGIN_ATTRIBUTE}="code"]`);
        await typeSecret(codeField, input.code);
        await submitFrom(code.frame, codeField);
        await settle(page);
      }
    }
    return {
      submitted: true,
      passwordFieldVisible: await passwordVisible(page),
      url: page.url(),
    };
  } catch {
    return answer("The login could not be typed into the page.");
  }
}
