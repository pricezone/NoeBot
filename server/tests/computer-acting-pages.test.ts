import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  ComputerUnavailableError,
  createComputerTransport,
  ElementNotFoundError,
  isDialogOpenError,
  isElementStateError,
  isSiteError,
  NavigationTimeoutError,
} from "../src/computer/client";
import {
  ActionRefusedError,
  type ComputerGateway,
  createComputerGateway,
  intentFor,
  NavigationRefusedError,
} from "../src/computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "../src/computer/headless-tools";
import type { PageFrameStore } from "../src/computer/page-frames";
import type { ActionPolicy } from "../src/computer/policy";
import type { PolicyStore } from "../src/computer/policy-store";
import type { ComputerProvider } from "../src/computer/provider";
import { createComputerRoutes } from "../src/computer/routes";
import type { SnapshotResult } from "../src/computer/schema";
import {
  createInMemorySnapshotStore,
  type SnapshotStore,
  withWriteThrough,
} from "../src/computer/snapshot-store";

/**
 * The server's half of acting on any site: what an acting call hands back (the page it produced,
 * stored so its refs work next), the errors that say what is actually wrong, a whole form governed
 * field by field, and the hot path's caches.
 */

const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };
const ACTOR = { id: "person-1" };

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://shop.example/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e1", role: "textbox", name: "Name" },
    { ref: "e2", role: "combobox", name: "Plan", options: ["Basic", "Pro"] },
    { ref: "e3", role: "checkbox", name: "I agree to the terms" },
    { ref: "e4", role: "button", name: "Photo" },
    { ref: "e9", role: "button", name: "Submit order" },
  ],
};

/** A page as the computer reports one after an action, with the full list the server stores. */
function reported(
  snapshotId: number,
  extra: Array<{ ref: string; role: string; name: string }> = [],
) {
  const elements = [...SNAPSHOT.elements, ...extra];
  return {
    url: SNAPSHOT.url,
    title: "Order",
    snapshotId,
    elements: ['e10 button "Confirm"'],
    changed: true,
    snapshot: { elements, truncated: false },
  };
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

function harness(
  options: {
    policy?: () => ActionPolicy;
    routes?: Record<string, (body: unknown) => Response | Promise<Response>>;
    locate?: () => Promise<string>;
    session?: () => string | undefined;
    snapshots?: SnapshotStore;
    locateCacheMs?: number;
    policyCacheMs?: number;
    pageFrames?: PageFrameStore;
  } = {},
) {
  const sent: Array<{ path: string; body?: unknown; address: string }> = [];
  let located = 0;
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => {
      located += 1;
      return options.locate ? options.locate() : "http://computer:4100";
    },
    ...(options.session ? { sessionOf: async () => options.session?.() } : {}),
    status: async (botId) => ({ botId, state: "ready" }),
    list: async () => [],
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    update: async () => ({ updated: true, wasRunning: true, to: "next" }),
  };
  const { store, rows } = fakeAudit();
  const gateway = createComputerGateway({
    provider,
    auditStore: store,
    policy: options.policy ?? (() => PERMISSIVE),
    ...(options.snapshots ? { snapshots: options.snapshots } : {}),
    ...(options.locateCacheMs !== undefined
      ? { locateCacheMs: options.locateCacheMs }
      : {}),
    ...(options.policyCacheMs !== undefined
      ? { policyCacheMs: options.policyCacheMs }
      : {}),
    ...(options.pageFrames ? { pageFrames: options.pageFrames } : {}),
    fetchImpl: (async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ path: parsed.pathname, body, address: parsed.origin });
      const route = options.routes?.[parsed.pathname];
      if (route) return route(body);
      if (parsed.pathname === "/snapshot") return Response.json(SNAPSHOT);
      if (parsed.pathname === "/screenshot")
        return Response.json({
          base64: "aGVsbG8=",
          width: 1,
          height: 1,
          capturedAt: "",
          url: SNAPSHOT.url,
        });
      return Response.json({
        action: parsed.pathname.slice(1),
        url: SNAPSHOT.url,
        elapsedMs: 1,
        page: reported(8, [{ ref: "e10", role: "button", name: "Confirm" }]),
      });
    }) as unknown as typeof fetch,
  });
  return { gateway, rows, sent, located: () => located };
}

describe("errors that say what is wrong", () => {
  const transport = (status: number, body: unknown) =>
    createComputerTransport({
      fetchImpl: (async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
  const failure = async (status: number, body: unknown) =>
    transport(status, body)
      .post("http://computer:4100", "bot", "/click", {})
      .catch((error: unknown) => error);

  test("an element problem is its own condition, with the tool and options that fit", async () => {
    const error = await failure(422, {
      error:
        "e2 is a drop-down list. Use computer_select with one of its options: Basic | Pro.",
      problem: "wrong_tool",
      useTool: "computer_select",
      options: ["Basic", "Pro"],
    });
    expect(isElementStateError(error)).toBe(true);
    if (!isElementStateError(error)) return;
    expect(error.problem).toBe("wrong_tool");
    expect(error.useTool).toBe("computer_select");
    expect(error.options).toEqual(["Basic", "Pro"]);
  });

  test("a covered element keeps the banner's buttons and their refs", async () => {
    const error = await failure(422, {
      error: "e9 is covered by a cookie banner.",
      problem: "covered",
      coveredBy: {
        label: "div.cookie",
        consent: true,
        buttons: [{ name: "Reject all", ref: "e12" }],
      },
    });
    expect(isElementStateError(error) && error.coveredBy?.buttons[0]?.ref).toBe(
      "e12",
    );
  });

  test("a site that is not there is a site error, not an unavailable computer", async () => {
    const error = await failure(502, {
      error: "That address does not exist (net::ERR_NAME_NOT_RESOLVED)",
      siteError: { problem: "dns", code: "net::ERR_NAME_NOT_RESOLVED" },
    });
    expect(isSiteError(error) && error.problem).toBe("dns");
    expect(error).not.toBeInstanceOf(ComputerUnavailableError);
  });

  test("a page paused on a dialog says so, and is not a stale snapshot", async () => {
    const error = await failure(409, {
      error: "A confirm dialog is open.",
      dialog: { type: "confirm", message: "Delete?" },
    });
    expect(isDialogOpenError(error) && error.dialog.message).toBe("Delete?");
  });

  test("an older computer's raw errors are told apart by their call log", async () => {
    const resolvedThen = (line: string) =>
      failure(500, {
        error: `locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e9')\n    - locator resolved to <button>Pay</button>\n  - ${line}`,
      });
    const covered = await resolvedThen(
      '<div class="cookie-consent">…</div> intercepts pointer events',
    );
    expect(isElementStateError(covered) && covered.problem).toBe("covered");
    expect((covered as Error).message).toContain(
      '<div class="cookie-consent">',
    );
    const disabled = await resolvedThen("element is not enabled");
    expect(isElementStateError(disabled) && disabled.problem).toBe("disabled");
    const hidden = await resolvedThen("element is not visible");
    expect(isElementStateError(hidden) && hidden.problem).toBe("not_visible");
    for (const error of [covered, disabled, hidden]) {
      expect((error as Error).message).not.toContain("Call log");
      expect((error as Error).message).not.toContain("fresh snapshot");
    }
    // Never resolved at all: not on the page, the one case a fresh snapshot fixes.
    const missing = await failure(500, {
      error:
        "locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=e9')\n",
    });
    expect(missing).toBeInstanceOf(ElementNotFoundError);
  });

  test("a navigation timeout is still a navigation timeout, and no call log reaches anyone", async () => {
    expect(
      await failure(502, {
        error:
          'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://slow.example/"',
      }),
    ).toBeInstanceOf(NavigationTimeoutError);
    const other = await failure(502, {
      error: "page.evaluate: Target crashed\nCall log:\n  - something",
    });
    expect((other as Error).message).toBe("Target crashed");
  });
});

describe("the page an action produced", () => {
  test("is stored, so a ref it lists resolves for the next action and the policy sees it", async () => {
    const denyConfirm: ActionPolicy = {
      ...PERMISSIVE,
      deny: ['element.name == "Confirm"'],
    };
    const { gateway, sent } = harness({ policy: () => denyConfirm });
    await gateway.snapshot("bot");
    const clicked = await gateway.click("bot", ACTOR, {
      ref: "e1",
      snapshotId: 7,
    });
    // The full list is for the store, never for the model.
    expect(clicked.page).toEqual({
      url: SNAPSHOT.url,
      title: "Order",
      snapshotId: 8,
      elements: ['e10 button "Confirm"'],
      changed: true,
    });
    expect((clicked as { untrusted?: string }).untrusted).toContain("page");
    // e10 exists only on the page the click produced; the policy resolves and refuses it.
    await expect(
      gateway.click("bot", ACTOR, { ref: "e10", snapshotId: 8 }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    expect(sent.filter((call) => call.path === "/click")).toHaveLength(1);
  });

  test("a navigation's page is stored too, so the Bot can act without a snapshot", async () => {
    const { gateway, rows } = harness({
      routes: {
        "/navigate": () =>
          Response.json({
            url: SNAPSHOT.url,
            title: "Order",
            text: "Order",
            truncated: false,
            elapsedMs: 1,
            page: { ...reported(3), status: 200 },
          }),
      },
    });
    const opened = await gateway.navigate("bot", ACTOR, SNAPSHOT.url);
    expect(opened.page?.status).toBe(200);
    expect(opened.page && "snapshot" in opened.page).toBe(false);
    const result = await gateway.click("bot", ACTOR, {
      ref: "e9",
      snapshotId: 3,
    });
    expect(result.element).toEqual({ role: "button", name: "Submit order" });
    expect(rows.at(-1)?.payload.element).toEqual({
      role: "button",
      name: "Submit order",
    });
  });
});

describe("a whole form in one call", () => {
  const input = {
    snapshotId: 7,
    fields: [
      { ref: "e1", text: "Ada Lovelace" },
      { ref: "e2", option: "Pro" },
      { ref: "e3", checked: true },
    ],
    // biome-ignore lint/suspicious/noThenProperty: `then` is the tool contract's field name.
    then: { click: "e9" },
  };

  test("each field is decided and recorded under the tool it stands for, in order", async () => {
    const { gateway, rows, sent } = harness({
      routes: {
        "/fill": (body) =>
          Response.json({
            action: "fill",
            url: SNAPSHOT.url,
            elapsedMs: 3,
            filled: (body as { fields: unknown[] }).fields.map((_, index) => ({
              index,
              ref: ["e1", "e2", "e3"][index],
              kind: ["text", "option", "checked"][index],
            })),
            afterwards: { clicked: "e9" },
            page: reported(8),
          }),
      },
    });
    await gateway.snapshot("bot");
    const result = await gateway.fill("bot", ACTOR, input);
    expect(rows.map((row) => row.payload.action)).toEqual([
      "computer_type",
      "computer_select",
      "computer_check",
      "computer_click",
    ]);
    expect(
      rows.every((row) => row.eventType === "computer.action_allowed"),
    ).toBe(true);
    // The typed text is in no row.
    expect(JSON.stringify(rows)).not.toContain("Ada Lovelace");
    // One request for all of it.
    expect(sent.filter((call) => call.path === "/fill")).toHaveLength(1);
    expect(result.filled.map((field) => field.element?.name)).toEqual([
      "Name",
      "Plan",
      "I agree to the terms",
    ]);
    expect(result.page?.snapshotId).toBe(8);
  });

  test("a refused field stops the batch there: the fields before it are sent, it and the click are not", async () => {
    const denyTerms: ActionPolicy = {
      ...PERMISSIVE,
      deny: [
        'tool.name == "computer_check" && contains(element.name, "terms")',
      ],
    };
    const { gateway, rows, sent } = harness({
      policy: () => denyTerms,
      routes: {
        "/fill": (body) =>
          Response.json({
            action: "fill",
            url: SNAPSHOT.url,
            elapsedMs: 3,
            filled: (body as { fields: unknown[] }).fields.map((_, index) => ({
              index,
              ref: ["e1", "e2"][index],
              kind: "text",
            })),
            page: reported(8),
          }),
      },
    });
    await gateway.snapshot("bot");
    const result = await gateway.fill("bot", ACTOR, input);
    const fill = sent.find((call) => call.path === "/fill")?.body as {
      fields: unknown[];
      then?: unknown;
    };
    expect(fill.fields).toHaveLength(2);
    expect(fill.then).toBeUndefined();
    expect(result.refused).toMatchObject({
      index: 2,
      ref: "e3",
      element: { role: "checkbox", name: "I agree to the terms" },
    });
    expect(result.refused?.reason).toContain("Field 2");
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
      "computer.action_allowed",
      "computer.action_refused",
    ]);
  });

  test("a first field refused sends nothing and is refused outright", async () => {
    const denyTyping: ActionPolicy = {
      ...PERMISSIVE,
      deny: ['tool.name == "computer_type"'],
    };
    const { gateway, sent } = harness({ policy: () => denyTyping });
    await gateway.snapshot("bot");
    await expect(gateway.fill("bot", ACTOR, input)).rejects.toBeInstanceOf(
      ActionRefusedError,
    );
    expect(sent.some((call) => call.path === "/fill")).toBe(false);
  });

  test("a file in a fill is governed with its path, like an upload", async () => {
    const noKeys: ActionPolicy = {
      ...PERMISSIVE,
      deny: ['file.extension == "pem"'],
    };
    const { gateway, rows } = harness({ policy: () => noKeys });
    await gateway.snapshot("bot");
    await expect(
      gateway.fill("bot", ACTOR, {
        snapshotId: 7,
        fields: [{ ref: "e4", file: "keys/server.pem" }],
      }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    expect(rows[0]?.payload).toMatchObject({
      action: "computer_upload",
      file: "keys/server.pem",
    });
  });

  test("a field the computer could not fill, and the steps after it, are recorded as not done", async () => {
    const { gateway, rows } = harness({
      routes: {
        "/fill": () =>
          Response.json({
            action: "fill",
            url: SNAPSHOT.url,
            elapsedMs: 3,
            filled: [{ index: 0, ref: "e1", kind: "text" }],
            failed: {
              index: 1,
              ref: "e2",
              error: 'e2 has no option "Pro".',
              problem: "no_such_option",
            },
            page: reported(8),
          }),
      },
    });
    await gateway.snapshot("bot");
    const result = await gateway.fill("bot", ACTOR, input);
    expect(result.failed?.index).toBe(1);
    const failures = rows.filter(
      (row) => row.eventType === "computer.action_failed",
    );
    expect(failures.map((row) => row.payload.action)).toEqual([
      "computer_select",
      "computer_check",
      "computer_click",
    ]);
  });
});

describe("the hot path", () => {
  test("a located computer is remembered for reads and page actions, and asked afresh for a ref", async () => {
    const { gateway, located } = harness();
    await gateway.screenshot("bot");
    await gateway.screenshot("bot");
    expect(located()).toBe(1);
    // A snapshot and a ref are resolved against the run the locate reports, so they locate afresh.
    await gateway.snapshot("bot");
    expect(located()).toBe(2);
    await gateway.scroll("bot", ACTOR, { deltaY: 100 });
    expect(located()).toBe(2);
    await gateway.click("bot", ACTOR, { ref: "e1", snapshotId: 8 });
    expect(located()).toBe(3);
  });

  test("stop, reset and update forget the address; zero turns the cache off", async () => {
    const { gateway, located } = harness();
    await gateway.screenshot("bot");
    await gateway.stopComputer("bot", ACTOR);
    await gateway.screenshot("bot");
    await gateway.resetComputer("bot", ACTOR);
    await gateway.screenshot("bot");
    await gateway.updateComputer("bot", ACTOR);
    await gateway.screenshot("bot");
    expect(located()).toBe(4);
    const uncached = harness({ locateCacheMs: 0 });
    await uncached.gateway.screenshot("bot");
    await uncached.gateway.screenshot("bot");
    expect(uncached.located()).toBe(2);
  });

  test("a changed policy is enforced on the very next action, never served from the cache", async () => {
    let current: ActionPolicy = PERMISSIVE;
    const { gateway } = harness({ policy: () => current });
    await gateway.snapshot("bot");
    await gateway.click("bot", ACTOR, { ref: "e1", snapshotId: 7 });
    // The store replaces its object on a change, which is what the cache keys on.
    current = { ...PERMISSIVE, deny: ["true"] };
    await expect(
      gateway.click("bot", ACTOR, { ref: "e1", snapshotId: 8 }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    current = PERMISSIVE;
    gateway.invalidatePolicy();
    await gateway.click("bot", ACTOR, { ref: "e1", snapshotId: 8 });
  });
});

describe("a nothing-behind-it address", () => {
  test("is retried only when the request never connected", async () => {
    let calls = 0;
    const provider: ComputerProvider = {
      name: "test",
      isolation: "per-bot",
      locate: async () => (calls === 0 ? "http://old:4100" : "http://new:4100"),
      status: async (botId) => ({ botId, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: true }),
      reset: async () => ({ cleared: true }),
    };
    const hits: string[] = [];
    const gateway = createComputerGateway({
      provider,
      auditStore: { insert: async () => undefined },
      policy: () => PERMISSIVE,
      fetchImpl: (async (url: string) => {
        const { origin } = new URL(url);
        hits.push(origin);
        if (origin === "http://old:4100" && calls > 0) {
          const error = new Error(
            "Unable to connect. Is the computer able to access the url?",
          );
          (error as Error & { code: string }).code = "ConnectionRefused";
          throw error;
        }
        calls += 1;
        return Response.json({
          base64: "aGVsbG8=",
          width: 1,
          height: 1,
          capturedAt: "",
        });
      }) as unknown as typeof fetch,
    });
    await gateway.screenshot("bot");
    await gateway.screenshot("bot");
    expect(hits).toEqual([
      "http://old:4100",
      "http://old:4100",
      "http://new:4100",
    ]);
  });
});

describe("the snapshot store, written through", () => {
  test("a save is visible at once and lands in the table in order", async () => {
    const table = createInMemorySnapshotStore();
    const saved: number[] = [];
    const slow: SnapshotStore = {
      save: async (id, snapshot) => {
        await Bun.sleep(5);
        saved.push(snapshot.snapshotId);
        await table.save(id, snapshot);
      },
      load: table.load,
      clear: table.clear,
    };
    const store = withWriteThrough(slow);
    const page = (snapshotId: number) => ({
      snapshotId,
      url: "https://x.test/",
      elements: new Map(),
    });
    await store.save("bot", page(1));
    await store.save("bot", page(2));
    expect((await store.load("bot", 2))?.snapshotId).toBe(2);
    expect(await table.load("bot")).toBeUndefined();
    await store.flush();
    expect(saved).toEqual([1, 2]);
    expect((await table.load("bot"))?.snapshotId).toBe(2);
  });

  test("a load without the caller's generation reads the table, which another replica may have moved on", async () => {
    const table = createInMemorySnapshotStore();
    const store = withWriteThrough(table);
    await store.saveNow("bot", {
      snapshotId: 3,
      url: "a",
      elements: new Map(),
    });
    await table.save("bot", { snapshotId: 9, url: "b", elements: new Map() });
    expect((await store.load("bot", 3))?.snapshotId).toBe(3);
    expect((await store.load("bot"))?.snapshotId).toBe(9);
  });

  test("a failed write is retried, then reported; a reset waits for writes ahead of it", async () => {
    const reports: string[] = [];
    let attempts = 0;
    const order: string[] = [];
    const store = withWriteThrough(
      {
        save: async () => {
          attempts += 1;
          order.push("save");
          throw new Error("connection reset");
        },
        load: async () => undefined,
        clear: async () => {
          order.push("clear");
        },
      },
      (message) => reports.push(message),
    );
    await store.save("bot", { snapshotId: 1, url: "a", elements: new Map() });
    await store.clear("bot");
    expect(attempts).toBe(3);
    expect(order.at(-1)).toBe("clear");
    expect(reports[0]).toContain("could not be stored after 3 attempts");
    expect(await store.load("bot", 1)).toBeUndefined();
  });
});

describe("the routes", () => {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id: "u1", email: "u1@openbot.test", role: "user" });
    await next();
  };

  test("warm starts the browser through the gateway, unrecorded", async () => {
    const warmed: string[] = [];
    const gateway = {
      warm: async (botId: string) => {
        warmed.push(botId);
        return { warm: true, launched: true, ms: 12 };
      },
    } as unknown as ComputerGateway;
    const routes = createComputerRoutes(
      gateway,
      {} as PolicyStore,
      requireUser,
      async () => true,
    );
    const response = await routes.request("http://openbot.test/bot-3/warm", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      warm: true,
      launched: true,
      ms: 12,
    });
    expect(warmed).toEqual(["bot-3"]);
  });

  test("a navigation answers before its frame is taken, and the next call waits for the frame", async () => {
    const order: string[] = [];
    const frames: string[] = [];
    const pageFrames = {
      save: async (frame: { toolCallId: string }) => {
        frames.push(frame.toolCallId);
      },
      load: async () => null,
      clear: async () => 0,
      purge: async () => 0,
    } as unknown as PageFrameStore;
    const gateway = {
      provider: { isolation: "per-bot" },
      navigate: async () => ({
        url: "https://x.test/",
        title: "X",
        text: "",
        truncated: false,
        elapsedMs: 1,
      }),
      status: async (botId: string) => ({ botId, state: "ready" }),
      screenshot: async () => {
        await Bun.sleep(150);
        order.push("frame");
        return { base64: "aGVsbG8=", url: "https://x.test/" };
      },
      click: async () => {
        order.push("click");
        return { action: "click", url: "https://x.test/", elapsedMs: 1 };
      },
    } as unknown as ComputerGateway;
    const routes = createComputerRoutes(
      gateway,
      {} as PolicyStore,
      requireUser,
      async () => true,
      pageFrames,
    );
    const started = Date.now();
    const navigated = await routes.request(
      "http://openbot.test/bot-1/navigate",
      {
        method: "POST",
        body: JSON.stringify({ url: "https://x.test/", toolCallId: "call-1" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(navigated.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(120);
    const clicked = await routes.request("http://openbot.test/bot-1/click", {
      method: "POST",
      body: JSON.stringify({ ref: "e1", snapshotId: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(clicked.status).toBe(200);
    expect(order).toEqual(["frame", "click"]);
    expect(frames).toEqual(["call-1"]);
  });

  test("new acting routes check their shape and map the new errors to their own statuses", async () => {
    const gateway = {
      select: async () => {
        const { elementStateError } = await import("../src/computer/client");
        throw elementStateError('e2 has no option "X".', "no_such_option", {
          options: ["A"],
        });
      },
      back: async () => {
        const { siteError } = await import("../src/computer/client");
        throw siteError("The site refused the connection.", "refused");
      },
      check: async () => {
        const { dialogOpenError } = await import("../src/computer/client");
        throw dialogOpenError("A confirm dialog is open.", {
          type: "confirm",
          message: "Sure?",
        });
      },
    } as unknown as ComputerGateway;
    const routes = createComputerRoutes(
      gateway,
      {} as PolicyStore,
      requireUser,
      async () => true,
    );
    const post = (path: string, body: unknown) =>
      routes.request(`http://openbot.test/bot-1${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
    expect((await post("/select", { ref: "e2", snapshotId: 1 })).status).toBe(
      400,
    );
    const noOption = await post("/select", {
      ref: "e2",
      snapshotId: 1,
      option: "X",
    });
    expect(noOption.status).toBe(422);
    expect(await noOption.json()).toMatchObject({
      problem: "no_such_option",
      options: ["A"],
    });
    const refused = await post("/back", {});
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({
      siteError: { problem: "refused" },
    });
    const paused = await post("/check", {
      ref: "e3",
      snapshotId: 1,
      checked: true,
    });
    expect(paused.status).toBe(409);
    expect(await paused.json()).toMatchObject({ dialog: { type: "confirm" } });
    expect(
      (
        await post("/fill", {
          snapshotId: 1,
          fields: [{ ref: "e1", text: "a", checked: true }],
        })
      ).status,
    ).toBe(400);
    expect((await post("/tabs", { action: "switch" })).status).toBe(400);
    expect((await post("/dialog", { accept: "yes" })).status).toBe(400);
  });
});

describe("the headless tools", () => {
  test("offer the new tools, and show the screen through the gateway's frame store", async () => {
    const kept: string[] = [];
    const pageFrames = {
      save: async (frame: { toolCallId: string }) => {
        kept.push(frame.toolCallId);
      },
      load: async () => ({ url: SNAPSHOT.url, title: null, frame: "x" }),
      clear: async () => 0,
      purge: async () => 0,
    } as unknown as PageFrameStore;
    const { gateway } = harness({ pageFrames });
    const tools = createHeadlessComputerTools({
      gateway,
      botId: "bot",
      actor: ACTOR,
    });
    const names = tools.map((tool) => tool.definition.name);
    for (const name of [
      "computer_fill",
      "computer_select",
      "computer_check",
      "computer_upload",
      "computer_hover",
      "computer_dialog",
      "computer_tabs",
      "computer_back",
      "computer_show_screen",
    ])
      expect(names).toContain(name);
    const show = tools.find(
      (tool) => tool.definition.name === "computer_show_screen",
    );
    const shown = await show?.execute(
      {},
      { toolCallId: "call-9", signal: new AbortController().signal },
    );
    expect(shown).toMatchObject({ ok: true, url: SNAPSHOT.url });
    expect(kept).toEqual(["call-9"]);
  });

  test("a challenge after a click pauses the unattended turn for the person", async () => {
    const { gateway } = harness({
      routes: {
        "/click": () =>
          Response.json({
            action: "click",
            url: SNAPSHOT.url,
            elapsedMs: 1,
            challenge: {
              kind: "visible-challenge",
              reason: "A CAPTCHA.",
              requestId: "req-1",
            },
            page: reported(8),
          }),
      },
    });
    await gateway.snapshot("bot");
    const tools = createHeadlessComputerTools({
      gateway,
      botId: "bot",
      actor: ACTOR,
    });
    const click = tools.find(
      (tool) => tool.definition.name === "computer_click",
    );
    const outcome = await click
      ?.execute(
        { ref: "e1", snapshotId: 7 },
        { toolCallId: "c", signal: new AbortController().signal },
      )
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(HeadlessToolSuspension);
    expect((outcome as HeadlessToolSuspension).waiting.requestId).toBe("req-1");
  });
});

describe("a value tool aimed at something that takes no value is a press", () => {
  const DENY_ACTIVATE: ActionPolicy = {
    ...PERMISSIVE,
    deny: ['intent == "activate"'],
  };

  test("the intent follows the element the server resolved", () => {
    expect(intentFor("computer_select", undefined, { role: "button" })).toBe(
      "activate",
    );
    expect(intentFor("computer_select", undefined, { role: "combobox" })).toBe(
      "type",
    );
    expect(intentFor("computer_type", undefined, { role: "checkbox" })).toBe(
      "activate",
    );
    expect(intentFor("computer_type", undefined, { role: "textbox" })).toBe(
      "type",
    );
    expect(intentFor("computer_type", "Enter", { role: "textbox" })).toBe(
      "activate",
    );
    expect(intentFor("computer_upload", undefined, { role: "button" })).toBe(
      "activate",
    );
    // An element the server could not resolve is not trusted to be a field.
    expect(intentFor("computer_select", undefined, undefined)).toBe("activate");
    expect(intentFor("computer_check", undefined, { role: "checkbox" })).toBe(
      "activate",
    );
    expect(intentFor("computer_scroll", undefined, undefined)).toBe("read");
  });

  test("a select handed the Submit button meets the rule against activating", async () => {
    const { gateway, sent } = harness({ policy: () => DENY_ACTIVATE });
    await gateway.snapshot("bot");
    await expect(
      gateway.select("bot", ACTOR, { ref: "e9", option: "x", snapshotId: 7 }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    await gateway.select("bot", ACTOR, {
      ref: "e2",
      option: "Pro",
      snapshotId: 7,
    });
    expect(sent.filter((call) => call.path === "/select")).toHaveLength(1);
  });

  test("typing into a checkbox, or uploading through a button, is decided as a press", async () => {
    const { gateway } = harness({ policy: () => DENY_ACTIVATE });
    await gateway.snapshot("bot");
    await expect(
      gateway.type("bot", ACTOR, { ref: "e3", text: "yes", snapshotId: 7 }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    await expect(
      gateway.upload("bot", ACTOR, {
        ref: "e4",
        path: "cv.pdf",
        snapshotId: 7,
      }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    await gateway.type("bot", ACTOR, { ref: "e1", text: "Ada", snapshotId: 7 });
  });

  test("inside a fill, the same rule applies field by field", async () => {
    const { gateway, rows } = harness({ policy: () => DENY_ACTIVATE });
    await gateway.snapshot("bot");
    await expect(
      gateway.fill("bot", ACTOR, {
        snapshotId: 7,
        fields: [{ ref: "e9", option: "x" }],
      }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    expect(rows[0]?.payload).toMatchObject({
      action: "computer_select",
      element: { role: "button", name: "Submit order" },
    });
  });
});

describe("going back", () => {
  test("is decided on the page it leads to, and the computer is told which", async () => {
    const away: ActionPolicy = {
      ...PERMISSIVE,
      deny: ['page.host == "evil.example"'],
    };
    const history = (url: string) => ({
      "/history": () => Response.json({ back: { url, title: "There" } }),
    });
    const refused = harness({
      policy: () => away,
      routes: history("https://evil.example/login"),
    });
    await expect(refused.gateway.back("bot", ACTOR)).rejects.toBeInstanceOf(
      ActionRefusedError,
    );
    expect(refused.rows[0]?.payload.page).toBe("https://evil.example/login");
    expect(refused.sent.some((call) => call.path === "/back")).toBe(false);

    const allowed = harness({
      policy: () => away,
      routes: history("https://shop.example/basket"),
    });
    await allowed.gateway.back("bot", ACTOR);
    expect(allowed.sent.find((call) => call.path === "/back")?.body).toEqual({
      expectedUrl: "https://shop.example/basket",
    });
  });

  test("a history entry the navigation guard refuses is refused here too", async () => {
    const { gateway, sent } = harness({
      routes: {
        "/history": () =>
          Response.json({ back: { url: "http://169.254.169.254/latest" } }),
      },
    });
    await expect(gateway.back("bot", ACTOR)).rejects.toBeInstanceOf(
      NavigationRefusedError,
    );
    expect(sent.some((call) => call.path === "/back")).toBe(false);
  });
});
