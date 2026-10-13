import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  chooseOption,
  clickElement,
  type FillOutcome,
  fillForm,
  scrollElement,
  setChecked,
  typeInto,
  uploadFile,
} from "../src/acting";
import { isElementProblem } from "../src/action-errors";
import { normaliseText, parseAriaSnapshot } from "../src/aria-snapshot";
import { classifyChallenge, readChallengeSignal } from "../src/challenge";
import { createDialogKeeper } from "../src/dialogs";
import { createDownloadKeeper } from "../src/downloads";
import { isSiteFailure, navigateWebPage } from "../src/navigation";
import { observeAction } from "../src/observe";
import { pageLines } from "../src/page-lines";
import { clickableHints, readablePageText, settlePage } from "../src/page-text";
import { createWorkspace } from "../src/workspace";

/**
 * The Bot's acting calls against a real Chromium and real pages served on 127.0.0.1: the controls
 * a form is made of, the things that get in the way of a click, dialogs, downloads, tabs, and a
 * multi-page form completed with one fill.
 *
 * Asked for by name, like `follows-popup.test.ts` and `sign-in.test.ts`: it launches a real browser,
 * which the machine running `bun test` is not required to have.
 *
 *   cd agent-computer && bunx playwright install chromium
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/browser-acting.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const BOT = "acting-test";
const LAUNCH_TIMEOUT_MS = 120_000;

const html = (body: string, status = 200, title = "Fixture") =>
  new Response(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

let origin = "";
let otherOrigin = "";
let server: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let browser: Browser;
let context: BrowserContext;
let root = "";
const dialogs = createDialogKeeper();
let downloads: ReturnType<typeof createDownloadKeeper>;

const PAGES: Record<string, () => string> = {
  "/covered": () => `
    <button onclick="document.title='bought'">Buy</button>
    <div id="cookie-banner" style="position:fixed;inset:0;background:#fff;z-index:9">
      <p>We use cookies to improve this site.</p>
      <button onclick="document.title='accepted'">Accept all</button>
      <button>Reject all</button>
    </div>`,
  "/disabled": () => `
    <label>Name <input disabled></label>
    <button disabled>Send</button>`,
  "/controls": () => `
    <style>.fancy input{position:absolute;opacity:0}</style>
    <label>Country <select id="country">
      <option value="gr">Greece</option><option value="cy">Cyprus</option>
      <option value="de" disabled>Germany</option></select></label>
    <label><input type="checkbox" id="terms"> Terms</label>
    <fieldset><legend>Size</legend>
      <label><input type="radio" name="size" value="s"> Small</label>
      <label><input type="radio" name="size" value="l"> Large</label></fieldset>
    <label>When <input type="date" id="when"></label>
    <label>Document <input type="file" id="doc"></label>
    <label class="fancy"><input type="checkbox" id="news"><span>Newsletter</span></label>
    <div role="combobox" aria-label="Colour" aria-expanded="false" tabindex="0"
      onclick="document.getElementById('colours').hidden=false">Pick a colour</div>
    <ul role="listbox" id="colours" hidden>
      <li role="option" onclick="document.getElementById('picked').textContent='Blue'">Blue</li>
      <li role="option" onclick="document.getElementById('picked').textContent='Red'">Red</li>
    </ul><span id="picked"></span>`,
  "/dialogs": () => `
    <button onclick="document.title = confirm('Submit the form?') ? 'yes' : 'no'">Confirm</button>
    <button onclick="document.title = prompt('Your name?', 'Anon') ?? 'none'">Prompt</button>`,
  "/panel": () => `
    <div id="panel" style="height:100px;overflow:auto;border:1px solid">
      <div style="height:1200px">top<button style="margin-top:900px;display:block">Deep</button></div>
    </div>`,
  "/turnstile": () =>
    `<p>Checking your browser</p><div class="cf-turnstile" style="width:300px;height:65px">widget</div>`,
  "/datadome": () =>
    `<iframe src="${otherOrigin}/frame?u=geo.captcha-delivery.com/captcha" width="300" height="300"></iframe>`,
  "/framed-check": () =>
    `<h1>Log in</h1><iframe src="${otherOrigin}/human-check" width="400" height="200"></iframe>`,
  "/greek-check": () =>
    `<p>Επιβεβαιώστε ότι είστε άνθρωπος</p><button>Δεν είμαι ρομπότ</button>`,
  "/invisible-recaptcha": () =>
    `<p>Sign up</p><iframe src="${otherOrigin}/x?u=google.com/recaptcha/api2/anchor&amp;size=invisible" width="256" height="60"></iframe>`,
  "/visible-recaptcha": () =>
    `<p>Sign up</p><iframe src="${otherOrigin}/x?u=google.com/recaptcha/api2/anchor" width="304" height="78"></iframe>`,
  "/article": () =>
    `<h1>What is a CAPTCHA?</h1><p>A CAPTCHA asks you to verify you are human.</p>`,
  "/downloads": () => `<a href="/file">Download report</a>`,
  "/spa": () => `
    <button onclick="history.pushState({}, '', '/spa/next');
      document.getElementById('view').innerHTML='<h1>Next step</h1><button>Continue</button>'">Go</button>
    <div id="view"><button>Old</button></div>
    <button onclick="document.getElementById('extra').hidden=false">Add</button>
    <button id="extra" hidden>Extra</button>`,
  "/form": () => `
    <h1>Application</h1>
    <form method="post" action="/preview">
      <label>Full name <input name="name" required></label>
      <label>Email <input name="email" type="email" required></label>
      <label>Country <select name="country">
        <option value="">Choose</option><option value="gr">Greece</option><option value="cy">Cyprus</option>
      </select></label>
      <label><input type="checkbox" name="terms" required> I accept the terms</label>
      <label>Locked <input name="locked" disabled></label>
      <button>Preview</button>
    </form>`,
  "/shadow": () => `
    <div id="host"></div><iframe src="${otherOrigin}/statement" width="400" height="200"></iframe>
    <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<p>Shadow balance 42</p>'</script>`,
};

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const page = PAGES[url.pathname];
      if (page) return html(page());
      if (url.pathname === "/boom") return html("<h1>Server error</h1>", 500);
      if (url.pathname === "/file")
        return new Response("report-bytes", {
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="report.pdf"',
          },
        });
      if (url.pathname === "/slow") {
        // The headers and the start of the page at once, the end of it three seconds later.
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                "<!doctype html><html><head><title>Slow</title></head><body><p>Arrived</p>",
              ),
            );
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            controller.enqueue(new TextEncoder().encode("</body></html>"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === "/preview" && request.method === "POST") {
        const form = await request.formData();
        const value = (key: string) => String(form.get(key) ?? "");
        return html(`
          <h1>Check your answers</h1>
          <p>Name: ${value("name")}</p><p>Email: ${value("email")}</p>
          <p>Country: ${value("country")}</p><p>Terms: ${value("terms")}</p>
          <form method="post" action="/confirm">
            <input type="hidden" name="name" value="${value("name")}">
            <button>Confirm and send</button></form>`);
      }
      if (url.pathname === "/confirm" && request.method === "POST") {
        const form = await request.formData();
        return html(
          `<h1>Submitted</h1><p>Thank you, ${String(form.get("name"))}. Reference 123.</p>`,
        );
      }
      return html("<h1>Not found</h1>", 404);
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/human-check")
        return html(
          `<p>Verify you are human</p><label><input type="checkbox"> I'm not a robot</label>`,
        );
      if (url.pathname === "/statement")
        return html(`<p>Framed statement 1,234.56</p>`);
      return html(`<p>${url.pathname}</p>`);
    },
  });
  otherOrigin = `http://127.0.0.1:${other.port}`;
  root = await mkdtemp(join(tmpdir(), "openbot-acting-"));
  downloads = createDownloadKeeper(createWorkspace(root));
  if (!asked) return;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  context = await browser.newContext({ acceptDownloads: true });
  dialogs.attach(BOT, context);
  downloads.attach(BOT, context);
}, LAUNCH_TIMEOUT_MS);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  other?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

async function open(path: string): Promise<Page> {
  const tab = await context.newPage();
  await tab.goto(`${origin}${path}`);
  return tab;
}

async function elementsOf(tab: Page) {
  const yaml = await tab.ariaSnapshot({ mode: "ai" });
  return parseAriaSnapshot(yaml, { clickableTexts: await clickableHints(tab) })
    .elements;
}

function refOf(
  elements: Awaited<ReturnType<typeof elementsOf>>,
  role: string,
  name: string,
): string {
  const found = elements.find(
    (element) => element.role === role && element.name === name,
  );
  if (!found)
    throw new Error(
      `No ${role} "${name}" in ${JSON.stringify(elements.map((e) => `${e.role} ${e.name}`))}`,
    );
  return found.ref;
}

const at = (tab: Page, ref: string) => tab.locator(`aria-ref=${ref}`);

/** Wait for something that happens a moment later: a dialog event, a download, a retarget. */
async function until<T>(
  read: () => T | Promise<T>,
  wanted: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!wanted(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

async function failure(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the action to fail.");
}

describe.skipIf(!asked)("acting on real pages", () => {
  test("a click under a cookie banner names the banner and its buttons, and clicks nothing", async () => {
    const tab = await open("/covered");
    const elements = await elementsOf(tab);
    const buy = refOf(elements, "button", "Buy");
    const accept = refOf(elements, "button", "Accept all");
    const started = Date.now();
    const error = await failure(
      clickElement(at(tab, buy), buy, "button", {
        timeoutMs: 10_000,
        refFor: (label) =>
          elements.find(
            (element) => normaliseText(element.name) === normaliseText(label),
          )?.ref,
      }),
    );
    expect(isElementProblem(error) && error.problem).toBe("covered");
    if (!isElementProblem(error)) return;
    expect(error.details.coveredBy?.consent).toBe(true);
    expect(error.details.coveredBy?.buttons).toContainEqual({
      name: "Accept all",
      ref: accept,
    });
    expect(error.message).toContain(accept);
    expect(error.message).not.toContain("Call log");
    // Given up on early, not after the whole timeout, and nothing was clicked on the Bot's behalf.
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(await tab.title()).toBe("Fixture");
    await tab.close();
  }, 30_000);

  test("a disabled field and button say they are disabled, not missing", async () => {
    const tab = await open("/disabled");
    const elements = await elementsOf(tab);
    const name = refOf(elements, "textbox", "Name");
    const send = refOf(elements, "button", "Send");
    const typed = await failure(
      typeInto(tab, at(tab, name), name, "Ada", false, { timeoutMs: 10_000 }),
    );
    expect(isElementProblem(typed) && typed.problem).toBe("disabled");
    const clicked = await failure(
      clickElement(at(tab, send), send, "button", { timeoutMs: 10_000 }),
    );
    expect(isElementProblem(clicked) && clicked.problem).toBe("disabled");
    await tab.close();
  }, 30_000);

  test("selects, checkboxes, radios, dates, files and custom drop-downs each get the right mechanism", async () => {
    const tab = await open("/controls");
    const elements = await elementsOf(tab);
    const options = { timeoutMs: 5_000 };
    const country = refOf(elements, "combobox", "Country");
    expect(elements.find((e) => e.ref === country)?.options).toEqual([
      "Greece",
      "Cyprus",
      "Germany",
    ]);

    // A native select: by label, by value, a typo answered with the list, a disabled option refused.
    expect(
      (await chooseOption(tab, at(tab, country), country, "Cyprus", options))
        .chosen,
    ).toBe("Cyprus");
    expect(await tab.locator("#country").inputValue()).toBe("cy");
    await chooseOption(tab, at(tab, country), country, "gr", options);
    expect(await tab.locator("#country").inputValue()).toBe("gr");
    const typo = await failure(
      chooseOption(tab, at(tab, country), country, "Spain", options),
    );
    expect(isElementProblem(typo) && typo.problem).toBe("no_such_option");
    expect((typo as Error).message).toContain("Greece | Cyprus | Germany");
    const off = await failure(
      chooseOption(tab, at(tab, country), country, "Germany", options),
    );
    expect(isElementProblem(off) && off.problem).toBe("disabled");

    // A click on it is refused with the options; typing into it chooses one.
    const clicked = await failure(
      clickElement(at(tab, country), country, "combobox", options),
    );
    expect(isElementProblem(clicked) && clicked.details.useTool).toBe(
      "computer_select",
    );
    expect(
      (await typeInto(tab, at(tab, country), country, "Cyprus", false, options))
        .routed,
    ).toBe("computer_select");
    expect(await tab.locator("#country").inputValue()).toBe("cy");

    // A checkbox, ticked and then unticked by "typing" no into it.
    const terms = refOf(elements, "checkbox", "Terms");
    await setChecked(tab, at(tab, terms), terms, true, options);
    expect(await tab.locator("#terms").isChecked()).toBe(true);
    expect(
      (await typeInto(tab, at(tab, terms), terms, "no", false, options)).routed,
    ).toBe("computer_check");
    expect(await tab.locator("#terms").isChecked()).toBe(false);

    // A radio: chosen, and refused when asked to untick.
    const large = refOf(elements, "radio", "Large");
    await setChecked(tab, at(tab, large), large, true, options);
    expect(await tab.locator('input[value="l"]').isChecked()).toBe(true);
    const untick = await failure(
      setChecked(tab, at(tab, large), large, false, options),
    );
    expect(isElementProblem(untick) && untick.problem).toBe("wrong_tool");

    // A date: ISO goes in; a local format is answered with the format the field takes.
    const when = refOf(elements, "textbox", "When");
    await typeInto(tab, at(tab, when), when, "2026-10-13", false, options);
    expect(await tab.locator("#when").inputValue()).toBe("2026-10-13");
    const local = await failure(
      typeInto(tab, at(tab, when), when, "13/10/2026", false, options),
    );
    expect(isElementProblem(local) && local.problem).toBe("invalid_value");
    expect((local as Error).message).toContain("YYYY-MM-DD");

    // A file input takes a workspace file directly.
    const file = join(root, "cv.txt");
    await writeFile(file, "curriculum vitae");
    const doc = refOf(elements, "button", "Document");
    await uploadFile(tab, at(tab, doc), doc, file, options);
    expect(
      await tab
        .locator("#doc")
        .evaluate((input) => (input as HTMLInputElement).files?.[0]?.name),
    ).toBe("cv.txt");

    // A styled checkbox whose input is invisible is ticked through its label.
    const news = refOf(elements, "checkbox", "Newsletter");
    await setChecked(tab, at(tab, news), news, true, options);
    expect(await tab.locator("#news").isChecked()).toBe(true);

    // A custom drop-down: opened, and its option clicked.
    const colour = refOf(elements, "combobox", "Colour");
    await chooseOption(tab, at(tab, colour), colour, "Blue", options);
    expect(await tab.locator("#picked").textContent()).toBe("Blue");
    await tab.close();
  }, 60_000);

  test("a confirm and a prompt are held for the Bot to answer, and one nobody answers is dismissed", async () => {
    const tab = await open("/dialogs");
    const elements = await elementsOf(tab);
    const confirmRef = refOf(elements, "button", "Confirm");
    const observed = await observeAction(dialogs, BOT, tab, () =>
      clickElement(at(tab, confirmRef), confirmRef, "button", {
        timeoutMs: 10_000,
      }),
    );
    expect(observed.dialog).toEqual({
      type: "confirm",
      message: "Submit the form?",
    });
    expect(dialogs.pending(BOT)?.type).toBe("confirm");
    await dialogs.answer(BOT, true);
    expect(
      await until(
        () => tab.title(),
        (t) => t === "yes",
      ),
    ).toBe("yes");

    const promptRef = refOf(elements, "button", "Prompt");
    const asked = await observeAction(dialogs, BOT, tab, () =>
      clickElement(at(tab, promptRef), promptRef, "button", {
        timeoutMs: 10_000,
      }),
    );
    expect(asked.dialog?.defaultValue).toBe("Anon");
    await dialogs.answer(BOT, true, "Ada");
    expect(
      await until(
        () => tab.title(),
        (t) => t === "Ada",
      ),
    ).toBe("Ada");

    // A keeper with a short hold, on its own browser context, for the minute nobody answers.
    const quick = createDialogKeeper({ holdMs: 300 });
    const own = await browser.newContext();
    quick.attach("quick", own);
    const lonely = await own.newPage();
    await lonely.goto(`${origin}/dialogs`);
    void lonely.getByRole("button", { name: "Confirm" }).click();
    expect(
      await until(
        () => quick.pending("quick")?.type,
        (t) => t === "confirm",
      ),
    ).toBe("confirm");
    expect(
      await until(
        () => quick.pending("quick"),
        (held) => held === undefined,
      ),
    ).toBeUndefined();
    expect(quick.takeExpired("quick")).toEqual({
      type: "confirm",
      message: "Submit the form?",
      dismissed: true,
    });
    expect(
      await until(
        () => lonely.title(),
        (t) => t === "no",
      ),
    ).toBe("no");
    await own.close();
    await tab.close();
  }, 30_000);

  test("an inner panel scrolls, and an element inside it scrolls into view", async () => {
    const tab = await open("/panel");
    const elements = await elementsOf(tab);
    const deep = refOf(elements, "button", "Deep");
    const panel = tab.locator("#panel");
    await scrollElement(at(tab, deep), deep, undefined, { timeoutMs: 5_000 });
    expect(await panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await panel.evaluate((node) => {
      node.scrollTop = 0;
    });
    const moved = await scrollElement(at(tab, deep), deep, 300, {
      timeoutMs: 5_000,
    });
    expect(moved.moved).toBe(300);
    expect(await panel.evaluate((node) => node.scrollTop)).toBe(300);
    await tab.close();
  }, 30_000);

  test("challenge markers are found in the page and in its frames, and ordinary pages are left alone", async () => {
    const kind = async (path: string) => {
      const tab = await open(path);
      await tab.waitForTimeout(300);
      const signal = await readChallengeSignal(tab);
      await tab.close();
      return classifyChallenge(signal)?.kind;
    };
    expect(await kind("/turnstile")).toBe("cloudflare");
    expect(await kind("/datadome")).toBe("visible-challenge");
    expect(await kind("/framed-check")).toBe("visible-challenge");
    expect(await kind("/greek-check")).toBe("visible-challenge");
    expect(await kind("/visible-recaptcha")).toBe("visible-challenge");
    expect(await kind("/invisible-recaptcha")).toBeUndefined();
    expect(await kind("/article")).toBeUndefined();
  }, 60_000);

  test("navigation reports the HTTP status, answers a slow page early, and names a site that is not there", async () => {
    const tab = await context.newPage();
    const missing = await navigateWebPage(
      tab,
      `${origin}/nowhere`,
      "managed",
      10_000,
    );
    expect(missing.response?.status()).toBe(404);
    const broken = await navigateWebPage(
      tab,
      `${origin}/boom`,
      "managed",
      10_000,
    );
    expect(broken.response?.status()).toBe(500);

    const started = Date.now();
    const slow = await navigateWebPage(
      tab,
      `${origin}/slow`,
      "managed",
      10_000,
      {
        documentWaitMs: 500,
      },
    );
    expect(slow.stillLoading).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_500);

    const nowhere = await failure(
      navigateWebPage(
        tab,
        "http://openbot-nothing.invalid/",
        "managed",
        10_000,
      ),
    );
    expect(isSiteFailure(nowhere) && nowhere.problem).toBe("dns");
    // A port nothing listens on: one this test held a moment ago.
    const closed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(""),
    });
    const port = closed.port;
    closed.stop(true);
    const refused = await failure(
      navigateWebPage(tab, `http://127.0.0.1:${port}/`, "managed", 10_000),
    );
    expect(isSiteFailure(refused) && refused.problem).toBe("refused");
    await tab.close();
  }, 60_000);

  test("a download lands in the workspace's Downloads folder, numbered when the name is taken", async () => {
    const tab = await open("/downloads");
    const elements = await elementsOf(tab);
    const link = refOf(elements, "link", "Download report");
    await clickElement(at(tab, link), link, "link", { timeoutMs: 5_000 });
    expect(await until(() => downloads.started(BOT), Boolean)).toBe(true);
    const first = await downloads.take(BOT);
    expect(first.download).toEqual({ path: "Downloads/report.pdf", bytes: 12 });
    expect(await readFile(join(root, "Downloads/report.pdf"), "utf8")).toBe(
      "report-bytes",
    );

    // Opening the file's address is a download too, not a failed navigation.
    const opened = await failure(
      navigateWebPage(tab, `${origin}/file`, "managed", 10_000),
    );
    expect(isSiteFailure(opened) && opened.problem).toBe("aborted");
    expect(await until(() => downloads.started(BOT), Boolean)).toBe(true);
    expect((await downloads.take(BOT)).download?.path).toBe(
      "Downloads/report (1).pdf",
    );
    await tab.close();
  }, 30_000);

  test("a change on the same page is reported as a diff, a route change as the whole new page", async () => {
    const tab = await open("/spa");
    const before = await elementsOf(tab);
    const add = refOf(before, "button", "Add");
    await clickElement(at(tab, add), add, "button", { timeoutMs: 5_000 });
    await settlePage(tab);
    const after = await elementsOf(tab);
    const same = pageLines(
      { url: tab.url(), elements: before },
      { url: tab.url(), elements: after },
    );
    expect(same.changed).toBe(true);
    expect(same.elements).toHaveLength(1);
    expect(same.elements[0]).toContain('button "Extra"');

    const go = refOf(after, "button", "Go");
    const from = tab.url();
    await clickElement(at(tab, go), go, "button", { timeoutMs: 5_000 });
    await settlePage(tab);
    expect(tab.url()).toEndWith("/spa/next");
    const next = await elementsOf(tab);
    const moved = pageLines(
      { url: from, elements: after },
      { url: tab.url(), elements: next },
    );
    expect(moved.changed).toBeUndefined();
    expect(moved.elements.join("\n")).toContain('button "Continue"');
    await tab.close();
  }, 30_000);

  test("page text includes open shadow roots and cross-origin frames", async () => {
    const tab = await open("/shadow");
    await tab.waitForTimeout(300);
    const { text } = await readablePageText(tab, 6_000);
    expect(text).toContain("Shadow balance 42");
    expect(text).toContain("Framed statement 1,234.56");
    await tab.close();
  }, 30_000);

  test("a multi-page form with a preview and a confirmation is completed with one fill per page", async () => {
    const tab = await open("/form");
    const elements = await elementsOf(tab);
    const ref = (role: string, name: string) => refOf(elements, role, name);
    const deps = {
      locate: async (wanted: string) => at(tab, wanted),
      roleOf: (wanted: string) => elements.find((e) => e.ref === wanted)?.role,
      uploadPath: async (path: string) => join(root, path),
      failure: (error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
        ...(isElementProblem(error) ? { problem: error.problem } : {}),
      }),
    };

    // One field that cannot be filled stops the batch there and says which and why.
    const stopped: FillOutcome = { filled: [] };
    await fillForm(
      tab,
      [
        { ref: ref("textbox", "Full name"), text: "Ada Lovelace" },
        { ref: ref("textbox", "Locked"), text: "nope" },
        { ref: ref("textbox", "Email"), text: "ada@example.test" },
      ],
      undefined,
      deps,
      { timeoutMs: 5_000 },
      stopped,
    );
    expect(stopped.filled).toHaveLength(1);
    expect(stopped.failed).toMatchObject({ index: 1, problem: "disabled" });

    const outcome: FillOutcome = { filled: [] };
    await fillForm(
      tab,
      [
        { ref: ref("textbox", "Full name"), text: "Ada Lovelace" },
        { ref: ref("textbox", "Email"), text: "ada@example.test" },
        { ref: ref("combobox", "Country"), option: "Cyprus" },
        { ref: ref("checkbox", "I accept the terms"), checked: true },
      ],
      { click: ref("button", "Preview") },
      deps,
      { timeoutMs: 5_000 },
      outcome,
    );
    expect(outcome.failed).toBeUndefined();
    expect(outcome.filled.map((field) => field.kind)).toEqual([
      "text",
      "text",
      "option",
      "checked",
    ]);
    expect(outcome.afterwards).toEqual({
      clicked: ref("button", "Preview"),
    });
    await settlePage(tab);
    const preview = await readablePageText(tab, 2_000);
    expect(preview.text).toContain("Check your answers");
    expect(preview.text).toContain("Name: Ada Lovelace");
    expect(preview.text).toContain("Country: cy");

    const confirm = refOf(await elementsOf(tab), "button", "Confirm and send");
    await clickElement(at(tab, confirm), confirm, "button", {
      timeoutMs: 5_000,
    });
    await settlePage(tab);
    expect((await readablePageText(tab, 2_000)).text).toContain(
      "Thank you, Ada Lovelace. Reference 123.",
    );

    // The same form submitted by `submit` rather than a click on its button.
    await tab.goto(`${origin}/form`);
    const again = await elementsOf(tab);
    const submitted: FillOutcome = { filled: [] };
    await fillForm(
      tab,
      [
        { ref: refOf(again, "textbox", "Full name"), text: "Grace Hopper" },
        { ref: refOf(again, "textbox", "Email"), text: "grace@example.test" },
        { ref: refOf(again, "checkbox", "I accept the terms"), checked: true },
      ],
      { submit: true },
      { ...deps, roleOf: () => undefined },
      { timeoutMs: 5_000 },
      submitted,
    );
    expect(submitted.afterwards).toEqual({ submitted: true });
    await settlePage(tab);
    expect((await readablePageText(tab, 2_000)).text).toContain(
      "Name: Grace Hopper",
    );
    await tab.close();
  }, 60_000);
});

describe.skipIf(!asked)("tabs and windows", () => {
  test(
    "a new tab and a pop-up become the live page, a chosen tab stays chosen, and a closing pop-up falls back",
    async () => {
      const { createProfiles } = await import("../src/profiles");
      const profileRoot = await mkdtemp(join(tmpdir(), "openbot-tabs-"));
      const profiles = createProfiles(profileRoot);
      const bot = "tabs-test";
      const settle = async (wanted: string) => {
        expect(
          await until(
            async () => (await profiles.page(bot)).url(),
            (url) => url.includes(wanted),
          ),
        ).toContain(wanted);
      };
      try {
        const opener = await profiles.page(bot);
        await opener.setContent(
          `<a href="${origin}/article" target="_blank">New tab</a>
         <button onclick="window.open('${origin}/dialogs','_blank','width=400,height=400')">Window</button>`,
        );
        await opener.getByRole("link").click();
        await settle("/article");
        expect(profiles.tabs(bot).pages).toHaveLength(2);

        await profiles.activate(bot, opener);
        expect(await profiles.page(bot)).toBe(opener);

        await opener.getByRole("button", { name: "Window" }).click();
        await settle("/dialogs");
        const popup = await profiles.page(bot);
        await popup.close();
        // Back to the tab the Bot chose, not merely the newest one left.
        expect(
          await until(
            () => profiles.page(bot),
            (page) => page === opener,
          ),
        ).toBe(opener);
      } finally {
        await profiles.stop(bot).catch(() => undefined);
        await rm(profileRoot, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    },
    LAUNCH_TIMEOUT_MS,
  );
});
