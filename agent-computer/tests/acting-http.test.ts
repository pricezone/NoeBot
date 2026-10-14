import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The computer's acting routes end to end: the real process (`src/index.ts`), a real headless
 * Chromium, and pages served on 127.0.0.1. What the Bot is handed back is checked here, field by
 * field: the `page` every acting call now carries, the diff on an unchanged page, the HTTP status of
 * a navigation, dialogs, tabs, back, a whole form in one fill, the warm-up, and errors that say what
 * is wrong without a Playwright call log.
 *
 *   OPENBOT_COMPUTER_BROWSER=1 bun test tests/acting-http.test.ts
 */
const asked = process.env.OPENBOT_COMPUTER_BROWSER === "1";
const token = "acting-http-test-token";
const BOT = "bot-acting";
let root = "";
let base = "";
let origin = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
let site: ReturnType<typeof Bun.serve> | undefined;

const page = (body: string, title = "Fixture", status = 200) =>
  new Response(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

type Page = {
  url: string;
  title: string;
  status?: number;
  snapshotId: number;
  elements: string[];
  changed?: true;
  dialog?: { type: string; message: string; dismissed?: true };
  opened?: { url: string };
  download?: { path: string; bytes: number };
  loading?: true;
  snapshot?: { elements: Array<{ ref: string; role: string; name: string }> };
};
type Answer = Record<string, unknown> & { page?: Page; error?: string };

async function call(path: string, body?: unknown, method = "POST") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-openbot-computer-token": token,
      "x-openbot-bot-id": BOT,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Answer };
}

/** The ref of the element on a page with this role and name, from the full snapshot it carried. */
function refIn(answer: { body: Answer }, role: string, name: string): string {
  const found = answer.body.page?.snapshot?.elements.find(
    (element) => element.role === role && element.name === name,
  );
  if (!found)
    throw new Error(
      `No ${role} "${name}" in ${JSON.stringify(answer).slice(0, 600)}`,
    );
  return found.ref;
}

beforeAll(async () => {
  if (!asked) return;
  site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/start":
          return page("<p>Start</p>", "Start");
        case "/later":
          return page(
            `<button>Start</button><div id="out"></div><script>setTimeout(() => { document.getElementById("out").textContent = "Hello World!"; }, 800);</script>`,
            "Later",
          );
        case "/shop":
          return page(
            `<h1>Shop</h1>
             <button onclick="document.getElementById('basket').hidden=false">Add to basket</button>
             <button id="basket" hidden>Go to basket</button>
             <label>Size <select><option>Small</option><option>Large</option></select></label>
             <label><input type="checkbox"> Gift wrap</label>
             <button onclick="document.title = confirm('Empty the basket?') ? 'emptied' : 'kept'">Empty basket</button>
             <a href="/other" target="_blank">Open help</a>
             <a href="/other">Help page</a>
             <label>Photo <input type="file"></label>`,
            "Shop",
          );
        case "/other":
          return page("<h1>Help</h1><p>How can we help?</p>", "Help");
        case "/interrupted":
          return page(
            `<label>First <input id="first"></label>
             <label>Second <input id="second" oninput="alert('Check this field')"></label>
             <label>Third <input id="third"></label>
             <button onclick="document.title='sent'">Send</button>`,
            "Interrupted",
          );
        case "/banner":
          return page(
            `<button>Pay</button>
             <div class="cookie-consent" style="position:fixed;inset:0;background:#fff">
               <p>This site uses cookies.</p><button>Accept all</button><button>Reject all</button>
             </div>`,
            "Banner",
          );
        case "/form":
          return page(
            `<form method="post" action="/done">
               <label>Name <input name="name"></label>
               <label>Plan <select name="plan"><option>Basic</option><option>Pro</option></select></label>
               <label><input type="checkbox" name="ok"> Agree</label>
               <button>Send</button></form>`,
            "Form",
          );
        case "/done": {
          const form = await request.formData();
          return page(
            `<h1>Done</h1><p>${String(form.get("name"))} on ${String(form.get("plan"))}, agreed ${String(form.get("ok"))}</p>`,
            "Done",
          );
        }
        default:
          return page("<h1>Not found</h1>", "Missing", 404);
      }
    },
  });
  origin = `http://127.0.0.1:${site.port}`;
  root = await mkdtemp(join(tmpdir(), "acting-http-"));
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  await probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace", "photo.png"), "not really a png");
  child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: token,
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      COMPUTER_DESKTOP_HOMEPAGE: `${origin}/start`,
      ACTION_TIMEOUT_MS: "6000",
      // No policy is pushed in this test; without this the egress filter refuses every connection.
      EGRESS_POLICY_REQUIRED: "0",
      PORT: String(port),
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`The computer exited with ${child.exitCode}.`);
    const up = await fetch(`${base}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (up) break;
    if (Date.now() > deadline) throw new Error("The computer did not start.");
    await Bun.sleep(100);
  }
}, 60_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await child?.exited;
  site?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!asked)("the computer's acting routes", () => {
  test("warming the browser starts it without going anywhere", async () => {
    const warmed = await call("/warm", {});
    expect(warmed.status).toBe(200);
    expect(warmed.body.warm).toBe(true);
    expect(typeof warmed.body.ms).toBe("number");
    const again = await call("/warm", {});
    expect(again.body.launched).toBe(false);
  }, 60_000);

  test("a read waits on the page for words that arrive later, and says when they never come", async () => {
    await call("/navigate", { url: `${origin}/later` });
    const started = Date.now();
    const found = await call("/read?waitFor=hello%20world", undefined, "GET");
    expect(found.status).toBe(200);
    expect(found.body.text).toContain("Hello World!");
    expect(found.body.waited).toMatchObject({
      for: "hello world",
      found: true,
    });
    expect(Date.now() - started).toBeLessThan(5_000);

    const never = await call(
      "/read?waitFor=Goodbye&timeoutMs=600",
      undefined,
      "GET",
    );
    expect(never.body.waited).toMatchObject({ for: "Goodbye", found: false });
  }, 60_000);

  test("a navigation hands back its status, short text and the page's elements", async () => {
    const missing = await call("/navigate", { url: `${origin}/nowhere` });
    expect(missing.status).toBe(200);
    expect(missing.body.page?.status).toBe(404);

    const opened = await call("/navigate", { url: `${origin}/shop` });
    expect(opened.status).toBe(200);
    expect(opened.body.page?.status).toBe(200);
    expect(opened.body.page?.title).toBe("Shop");
    expect(opened.body.page?.changed).toBeUndefined();
    expect(opened.body.page?.elements.join("\n")).toContain(
      'button "Add to basket"',
    );
    expect(String(opened.body.text).length).toBeLessThanOrEqual(2000);
  }, 60_000);

  test("a click answers with only what changed on the page, and the new refs work", async () => {
    const shop = await call("/navigate", { url: `${origin}/shop` });
    const add = refIn(shop, "button", "Add to basket");
    const clicked = await call("/click", {
      ref: add,
      snapshotId: shop.body.page?.snapshotId,
    });
    expect(clicked.status).toBe(200);
    expect(clicked.body.page?.changed).toBe(true);
    expect(clicked.body.page?.elements).toHaveLength(1);
    expect(clicked.body.page?.elements[0]).toContain('button "Go to basket"');

    // A ref from before the click still works with the new snapshotId: refs survive a diff.
    const size = refIn(shop, "combobox", "Size");
    const chosen = await call("/select", {
      ref: size,
      option: "Large",
      snapshotId: clicked.body.page?.snapshotId,
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.chosen).toBe("Large");
    expect(chosen.body.page?.elements.join("\n")).toContain('= "Large"');

    const wrap = refIn(shop, "checkbox", "Gift wrap");
    const ticked = await call("/check", {
      ref: wrap,
      checked: true,
      snapshotId: chosen.body.page?.snapshotId,
    });
    expect(ticked.status).toBe(200);
    expect(ticked.body.page?.elements.join("\n")).toContain("[checked]");
  }, 60_000);

  test("a click on a drop-down is refused with its options, in words and without a call log", async () => {
    const shop = await call("/navigate", { url: `${origin}/shop` });
    const size = refIn(shop, "combobox", "Size");
    const refused = await call("/click", {
      ref: size,
      snapshotId: shop.body.page?.snapshotId,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.problem).toBe("wrong_tool");
    expect(refused.body.useTool).toBe("computer_select");
    expect(refused.body.options).toEqual(["Small", "Large"]);
    expect(refused.body.error).not.toContain("Call log");
  }, 60_000);

  test("a covered button names the consent banner and its buttons' refs", async () => {
    const banner = await call("/navigate", { url: `${origin}/banner` });
    const pay = refIn(banner, "button", "Pay");
    const reject = refIn(banner, "button", "Reject all");
    const covered = await call("/click", {
      ref: pay,
      snapshotId: banner.body.page?.snapshotId,
    });
    expect(covered.status).toBe(422);
    expect(covered.body.problem).toBe("covered");
    expect(covered.body.error).toContain(reject);
    expect(covered.body.error).toContain("consent banner");
  }, 60_000);

  test("a confirm dialog is held, blocks other actions, and is answered with computer_dialog", async () => {
    const shop = await call("/navigate", { url: `${origin}/shop` });
    const empty = refIn(shop, "button", "Empty basket");
    const clicked = await call("/click", {
      ref: empty,
      snapshotId: shop.body.page?.snapshotId,
    });
    expect(clicked.status).toBe(200);
    expect(clicked.body.page?.dialog).toEqual({
      type: "confirm",
      message: "Empty the basket?",
    });
    const blocked = await call("/click", {
      ref: empty,
      snapshotId: shop.body.page?.snapshotId,
    });
    expect(blocked.status).toBe(409);
    expect((blocked.body.dialog as { type?: string })?.type).toBe("confirm");
    const answered = await call("/dialog", { accept: true });
    expect(answered.status).toBe(200);
    expect(answered.body.accepted).toBe(true);
    expect(answered.body.page?.title).toBe("emptied");
    const nothing = await call("/dialog", { accept: false });
    expect(nothing.status).toBe(422);
    expect(nothing.body.problem).toBe("no_dialog");
  }, 60_000);

  test("a link that opens a new tab says so, and tabs can be listed, switched and closed", async () => {
    const shop = await call("/navigate", { url: `${origin}/shop` });
    const help = refIn(shop, "link", "Open help");
    const opened = await call("/click", {
      ref: help,
      snapshotId: shop.body.page?.snapshotId,
    });
    expect(opened.status).toBe(200);
    expect(opened.body.page?.opened?.url).toBe(`${origin}/other`);
    expect(opened.body.page?.title).toBe("Help");

    const listed = await call("/tabs", { action: "list" });
    const tabs = listed.body.tabs as Array<{
      index: number;
      url: string;
      active: boolean;
    }>;
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    const shopTab = tabs.find((tab) => tab.url.endsWith("/shop"));
    expect(tabs.find((tab) => tab.active)?.url).toBe(`${origin}/other`);

    const switched = await call("/tabs", {
      action: "switch",
      index: shopTab?.index,
    });
    expect(switched.body.page?.title).toBe("Shop");
    const helpTab = (switched.body.tabs as typeof tabs).find((tab) =>
      tab.url.endsWith("/other"),
    );
    const closed = await call("/tabs", {
      action: "close",
      index: helpTab?.index,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.page?.title).toBe("Shop");
  }, 60_000);

  test("back returns to the previous page, and says when there is none", async () => {
    await call("/navigate", { url: `${origin}/shop` });
    const help = await call("/navigate", { url: `${origin}/other` });
    expect(help.body.page?.title).toBe("Help");
    const back = await call("/back", {});
    expect(back.status).toBe(200);
    expect(back.body.wentBack).toBe(true);
    expect(back.body.page?.title).toBe("Shop");
  }, 60_000);

  test("a whole form is filled and sent in one call", async () => {
    const form = await call("/navigate", { url: `${origin}/form` });
    const filled = await call("/fill", {
      snapshotId: form.body.page?.snapshotId,
      fields: [
        { ref: refIn(form, "textbox", "Name"), text: "Ada" },
        { ref: refIn(form, "combobox", "Plan"), option: "Pro" },
        { ref: refIn(form, "checkbox", "Agree"), checked: true },
      ],
      // biome-ignore lint/suspicious/noThenProperty: `then` is the tool contract's field name.
      then: { click: refIn(form, "button", "Send") },
    });
    expect(filled.status).toBe(200);
    expect(filled.body.failed).toBeUndefined();
    expect((filled.body.filled as unknown[]).length).toBe(3);
    expect(filled.body.afterwards).toEqual({
      clicked: refIn(form, "button", "Send"),
    });
    expect(filled.body.page?.title).toBe("Done");
    const text = await call("/read", undefined, "GET");
    expect(String(text.body.text)).toContain("Ada on Pro, agreed on");
  }, 60_000);

  test("choosing an option in a button is refused and the button is not pressed", async () => {
    const shop = await call("/navigate", { url: `${origin}/shop` });
    const empty = refIn(shop, "button", "Empty basket");
    const refused = await call("/select", {
      ref: empty,
      option: "Yes",
      snapshotId: shop.body.page?.snapshotId,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.problem).toBe("wrong_tool");
    const read = await call("/read", undefined, "GET");
    expect(read.body.title).toBe("Shop");
  }, 60_000);

  test("a fill a dialog interrupts says where it stopped, and nothing after it runs once answered", async () => {
    const form = await call("/navigate", { url: `${origin}/interrupted` });
    const filled = await call("/fill", {
      snapshotId: form.body.page?.snapshotId,
      fields: [
        { ref: refIn(form, "textbox", "First"), text: "one" },
        { ref: refIn(form, "textbox", "Second"), text: "two" },
        { ref: refIn(form, "textbox", "Third"), text: "three" },
      ],
      // biome-ignore lint/suspicious/noThenProperty: `then` is the tool contract's field name.
      then: { click: refIn(form, "button", "Send") },
    });
    expect(filled.status).toBe(200);
    expect(filled.body.page?.dialog?.message).toBe("Check this field");
    expect(filled.body.failed).toMatchObject({
      index: 1,
      problem: "interrupted",
    });
    expect(
      (filled.body.filled as Array<{ index: number }>).map((f) => f.index),
    ).toEqual([0]);
    const answered = await call("/dialog", { accept: true });
    expect(answered.status).toBe(200);
    await Bun.sleep(300);
    const read = await call("/read", undefined, "GET");
    expect(read.body.title).toBe("Interrupted");
    const snapshot = await call("/snapshot", {});
    const third = (
      snapshot.body.elements as Array<{ name: string; value?: string }>
    ).find((element) => element.name === "Third");
    expect(third?.value).toBeUndefined();
  }, 60_000);

  test("back is told where it leads, and refuses to go once that has changed", async () => {
    await call("/navigate", { url: `${origin}/shop` });
    await call("/navigate", { url: `${origin}/other` });
    const history = await call("/history", undefined, "GET");
    expect((history.body.back as { url?: string })?.url).toBe(`${origin}/shop`);
    const moved = await call("/back", { expectedUrl: `${origin}/form` });
    expect(moved.status).toBe(409);
    const back = await call("/back", { expectedUrl: `${origin}/shop` });
    expect(back.status).toBe(200);
    expect(back.body.page?.title).toBe("Shop");
  }, 60_000);

  test("an upload takes a workspace file, and a path outside the workspace is refused", async () => {
    const shop = await call("/navigate", { url: `${origin}/shop` });
    const photo = refIn(shop, "button", "Photo");
    const uploaded = await call("/upload", {
      ref: photo,
      path: "photo.png",
      snapshotId: shop.body.page?.snapshotId,
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.path).toBe("photo.png");
    const escaped = await call("/upload", {
      ref: photo,
      path: "../secret.txt",
      snapshotId: uploaded.body.page?.snapshotId,
    });
    expect(escaped.status).toBe(403);
  }, 60_000);
});
