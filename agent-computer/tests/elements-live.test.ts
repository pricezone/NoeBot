import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * Clicky's questions about the screen, asked of a real browser: the boxes come back where the page
 * drew them, the point under a box names it, and the frame the model is shown has the sensitive field
 * masked. Opt in with OPENBOT_ELEMENTS_LIVE=1; it starts a headless computer like the
 * demonstration's live test.
 */
const asked = process.env.OPENBOT_ELEMENTS_LIVE === "1";
const token = "elements-fixture-token";
const botId = "elements-fixture";
let root = "";
let base = "";
let child: ReturnType<typeof Bun.spawn> | undefined;
let site: ReturnType<typeof Bun.serve> | undefined;

async function api(path: string, input?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      "x-openbot-computer-token": token,
      "x-openbot-bot-id": botId,
      "content-type": "application/json",
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      `Computer fixture ${path} answered ${response.status}: ${JSON.stringify(body)}`,
    );
  return body;
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "elements-fixture-"));
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  await probe.stop(true);
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: token,
      PORT: String(port),
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      EGRESS_POLICY_REQUIRED: "0",
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: join(root, "workspace"),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`Computer fixture exited with ${child.exitCode}.`);
    let ready = false;
    try {
      ready = (await fetch(`${base}/health`)).ok;
    } catch {
      /* Readiness may precede binding; bounded by deadline below. */
    }
    if (ready) break;
    if (Date.now() > deadline)
      throw new Error("Computer fixture did not start.");
    await Bun.sleep(25);
  }
}, 15000);

afterAll(async () => {
  if (!asked) return;
  if (child?.exitCode === null) {
    try {
      await api("/computers/stop", {});
    } finally {
      child.kill();
      await child.exited;
    }
  }
  site?.stop(true);
  if (root) await rm(root, { recursive: true, force: true });
}, 15000);

type Listed = {
  screen: { width: number; height: number };
  mode: string;
  elements: {
    ref: string;
    role: string;
    name: string;
    rect: { x: number; y: number; width: number; height: number };
    sensitive: boolean;
    focused: boolean;
  }[];
};

describe.skipIf(!asked)("Clicky's view of a real page", () => {
  test("boxes, the element at a point, and a masked frame", async () => {
    const html = `<!doctype html><body style="margin:0">
      <button style="position:absolute;left:100px;top:50px;width:120px;height:40px">Continue</button>
      <label style="position:absolute;left:100px;top:150px">Code <input id="code" autocomplete="one-time-code" value="424242"></label>
      <input type="password" style="position:absolute;left:100px;top:250px" value="hunter2" aria-label="Password" autofocus>
      <input name="pin" aria-label="Card PIN" style="position:absolute;left:100px;top:350px" value="9876">
      <a href="#" style="position:absolute;left:100px;top:3000px">Far below</a>
      <form style="position:absolute;left:400px;top:50px"><button style="width:100px;height:40px">Go</button></form>
      <div id="host" style="position:absolute;left:400px;top:150px"></div>
      <iframe style="position:absolute;left:400px;top:250px;width:200px;height:80px" title="Card"></iframe>
      <div role="alertdialog" style="position:absolute;left:700px;top:50px"><button style="width:80px;height:30px">OK</button></div>
      <script>
        const root = document.getElementById("host").attachShadow({ mode: "open" });
        root.innerHTML = '<input id="otp" name="otp" value="135790" style="width:150px">';
      </script>
    </body>`;
    site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(html, { headers: { "content-type": "text/html" } }),
    });
    // Nothing is opened just to be looked at: before any page, the page-only computer says so.
    await expect(api("/elements")).rejects.toThrow("409");
    await api("/navigate", { url: `http://127.0.0.1:${site.port}/` });
    const before = await api("/snapshot", {});
    expect(
      (before.elements as { name: string; value?: string }[]).find(
        (e) => e.name === "Card PIN",
      )?.value,
    ).toBe("9876");

    const listed = (await api("/elements")) as Listed;
    expect(listed.mode).toBe("page");
    const button = listed.elements.find((e) => e.name === "Continue");
    expect(button?.role).toBe("button");
    expect(button?.rect).toEqual({ x: 100, y: 50, width: 120, height: 40 });
    const password = listed.elements.find((e) => e.name === "Password");
    expect(password?.sensitive).toBe(true);
    expect(password?.focused).toBe(true);
    const code = listed.elements.find(
      (e) => e.role === "textbox" && e !== password,
    );
    expect(code?.sensitive).toBe(true);
    // Off-screen controls are not pointed at.
    expect(listed.elements.some((e) => e.name === "Far below")).toBe(false);

    const at = await api("/elements/at", { x: 150, y: 70 });
    expect(at).toMatchObject({
      role: "button",
      name: "Continue",
      sensitive: false,
      inPage: true,
      ref: button?.ref,
    });
    const atPassword = await api("/elements/at", {
      x: (password?.rect.x ?? 0) + 5,
      y: (password?.rect.y ?? 0) + 5,
    });
    expect(atPassword.sensitive).toBe(true);
    expect(atPassword.name).toBe("[sensitive field]");

    // A button in a form sends it; a field inside a web component is still a secret; a frame is
    // something nothing here can read into.
    expect(await api("/elements/at", { x: 420, y: 60 })).toMatchObject({
      role: "button",
      name: "Go",
      submits: true,
    });
    expect(await api("/elements/at", { x: 150, y: 70 })).toMatchObject({
      submits: false,
    });
    expect(await api("/elements/at", { x: 410, y: 160 })).toMatchObject({
      role: "textbox",
      sensitive: true,
    });
    expect(await api("/elements/at", { x: 450, y: 280 })).toMatchObject({
      role: "frame",
      opaque: true,
    });
    // "OK" in a confirmation says nothing about what it confirms.
    expect(await api("/elements/at", { x: 720, y: 60 })).toMatchObject({
      role: "button",
      name: "OK",
      inDialog: true,
    });
    // Without verifyWindow nothing is asked about windows: a page-only computer has none.
    expect(
      (await api("/elements/at", { x: 150, y: 70 })).window,
    ).toBeUndefined();
    // The keyboard is in the password field the page focused.
    const focus = await api("/elements/focus");
    expect(focus).toMatchObject({
      window: "browser",
      element: { role: "textbox", sensitive: true },
    });

    const frame = await api("/elements/frame?width=640");
    expect(frame.width).toBeLessThanOrEqual(640);
    expect(Buffer.from(frame.image, "base64").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
    const full = await api("/elements/frame");
    expect(full.width).toBeGreaterThan(640);
    // Looking did not retire the Bot's refs: the snapshot it took before still clicks.
    const continueRef = (
      before.elements as { ref: string; name: string }[]
    ).find((e) => e.name === "Continue")?.ref;
    const clicked = await api("/click", {
      ref: continueRef,
      snapshotId: before.snapshotId,
    });
    expect(clicked.action).toBe("click");
    // A field only its label calls secret was marked before the picture, as a typed secret is, so
    // the Bot's next read of the page hides its value too.
    const after = await api("/snapshot", {});
    const pin = (after.elements as { name: string; value?: string }[]).find(
      (e) => e.name === "Card PIN",
    );
    expect(pin?.value).toBe("[hidden: sensitive field]");
    // And the one inside the shadow root too.
    expect(JSON.stringify(before.elements)).toContain("135790");
    expect(JSON.stringify(after.elements)).not.toContain("135790");
  }, 30000);

  test("the whole page: off the screen, the scroll, the text, where the page is, and a ref's box", async () => {
    const links = Array.from(
      { length: 260 },
      (_, index) =>
        `<a href="#l${index}" style="position:absolute;left:10px;top:${index * 10}px;font-size:8px">Link ${index}</a>`,
    ).join("");
    const html = `<!doctype html><title>Long page</title><body style="margin:0;height:5000px">
      ${links}
      <form style="position:absolute;left:300px;top:2950px"><input aria-label="Search the site" name="q" style="width:200px;height:24px"></form>
      <button style="position:absolute;left:300px;top:3050px;width:120px;height:30px">Visible A</button>
      <input aria-label="Notes" style="position:absolute;left:600px;top:3050px;width:120px;height:24px">
      <button style="position:absolute;left:300px;top:4500px;width:120px;height:30px">Bottom</button>
      <script>addEventListener("load", () => scrollTo(0, 2900));</script>
    </body>`;
    const second = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/next"
          ? new Response("<!doctype html><title>Next</title><p>Next page</p>", {
              headers: { "content-type": "text/html" },
            })
          : new Response(html, { headers: { "content-type": "text/html" } }),
    });
    try {
      await api("/navigate", { url: `http://127.0.0.1:${second.port}/` });
      // The first 260 controls in the document are all above the screen; the visible ones are found.
      const listed = (await api("/elements")) as Listed & {
        title?: string;
        scroll?: { y: number; height: number; viewport: number };
        offscreen?: {
          ref: string;
          name: string;
          offscreen: string;
          y: number;
        }[];
      };
      expect(listed.title).toBe("Long page");
      expect(listed.scroll?.y).toBe(2900);
      expect(listed.scroll?.height).toBeGreaterThanOrEqual(5000);
      const visibleA = listed.elements.find((e) => e.name === "Visible A");
      expect(visibleA?.rect).toEqual({
        x: 300,
        y: 150,
        width: 120,
        height: 30,
      });
      const search = listed.elements.find((e) => e.name === "Search the site");
      // A text field that answers is judged by what it is: a search box is no secret.
      expect(search?.sensitive).toBe(false);
      const bottom = listed.offscreen?.find((e) => e.name === "Bottom");
      expect(bottom).toMatchObject({ offscreen: "below", y: 4500 });
      // Nearest first: the last links above the screen come before the first ones.
      const above = (listed.offscreen ?? []).filter(
        (e) => e.offscreen === "above",
      );
      expect(above[0]?.name).toBe("Link 259");

      const text = await api("/elements/text");
      expect(text.text).toContain("Visible A");
      expect(text.url).toBe(`http://127.0.0.1:${second.port}/`);

      // Just after a navigation the page is still settling; a moment later it has.
      let state = await api("/elements/state");
      for (let tries = 0; !state.settled && tries < 30; tries += 1) {
        await Bun.sleep(100);
        state = await api("/elements/state");
      }
      expect(state).toMatchObject({
        url: `http://127.0.0.1:${second.port}/`,
        title: "Long page",
        settled: true,
      });

      // Where the Bot's own ref is, without taking a look of Clicky's own.
      const snapshot = await api("/snapshot", {});
      const ref = (snapshot.elements as { ref: string; name: string }[]).find(
        (e) => e.name === "Visible A",
      )?.ref;
      const where = await api(
        `/elements/ref?ref=${ref}&snapshotId=${snapshot.snapshotId}`,
      );
      expect(where.rect).toEqual({ x: 300, y: 150, width: 120, height: 30 });
      expect(
        (
          await api(
            `/elements/ref?ref=${ref}&snapshotId=${snapshot.snapshotId + 5}`,
          )
        ).rect,
      ).toBeNull();

      // The person's own Take control says so.
      const asked = await api("/control/request", {
        reason: "I want to take control of the browser.",
        source: "manual",
      });
      expect(asked.request.source).toBe("manual");
      await api("/control/take", { requestId: asked.request.id });
      try {
        // Typing through the page's keyboard, once the field clicked has it.
        await api("/human/click", { x: 350, y: 62 });
        await api("/human/type", {
          text: "δήλωση",
          keyboard: "page",
          at: { x: 350, y: 62 },
        });
        const typed = await api("/snapshot", {});
        expect(
          (typed.elements as { name: string; value?: string }[]).find(
            (e) => e.name === "Search the site",
          )?.value,
        ).toBe("δήλωση");
        // A field that does not have the keyboard gets nothing.
        await expect(
          api("/human/type", {
            text: "nope",
            keyboard: "page",
            at: { x: 650, y: 160 },
          }),
        ).rejects.toThrow("400");
        // And off the screen is brought into view by its ref.
        await api("/human/scroll-into-view", { ref: bottom?.ref });
        const scrolled = (await api("/elements")) as {
          scroll?: { y: number };
          elements: { name: string }[];
        };
        expect(scrolled.elements.some((e) => e.name === "Bottom")).toBe(true);
        expect(scrolled.scroll?.y ?? 0).toBeGreaterThan(2900);
        await expect(
          api("/human/scroll-into-view", { ref: "not a ref" }),
        ).rejects.toThrow("400");
      } finally {
        await api("/control/release", { requestId: asked.request.id });
      }

      // A navigation counts once it has settled.
      const navigated = state.navigationId as number;
      // The Bot looks after a handback before it acts again.
      await api("/snapshot", {});
      await api("/navigate", { url: `http://127.0.0.1:${second.port}/next` });
      const deadline = Date.now() + 5000;
      let now = await api("/elements/state");
      while (now.navigationId === navigated && Date.now() < deadline) {
        await Bun.sleep(100);
        now = await api("/elements/state");
      }
      expect(now.navigationId).toBeGreaterThan(navigated);
      expect(now).toMatchObject({ title: "Next", settled: true });
    } finally {
      second.stop(true);
    }
  }, 40000);
});
