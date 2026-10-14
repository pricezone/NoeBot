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
  }, 30000);
});
