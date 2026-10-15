import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { ClickySession } from "../../shared/clicky";
import type { ClickyActions } from "../src/clicky/actions";
import type { ClickyBrain } from "../src/clicky/brain";
import { createClickyHub } from "../src/clicky/hub";
import { createClickyRoutes } from "../src/clicky/routes";
import {
  type ClickyPreferences,
  createClickyService,
} from "../src/clicky/service";
import { createInMemoryClickyStore } from "../src/clicky/store";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { ScreenElements } from "../src/computer/schema";

/*
 * Clicky's commands, through the route: a body that does not hold together is a 400, a command the
 * state machine refuses is a 200 that names the notice, and Stop stops an action that is already
 * running and drops the proposal it was running.
 */

const screen: ScreenElements = {
  screen: { width: 1000, height: 500 },
  mode: "page",
  url: "https://shop.example/cart",
  elements: [
    {
      ref: "e1",
      role: "button",
      name: "Continue",
      rect: { x: 100, y: 100, width: 100, height: 50 },
      sensitive: false,
      focused: false,
    },
  ],
};

const preferences = async (): Promise<ClickyPreferences> => ({
  locale: "en",
  guidance: "brief",
  actionPolicy: "ask_each",
  autoActivate: true,
});

function harness(
  options: {
    actions?: ClickyActions;
    brain?: ClickyBrain;
    audit?: (row: AuditEventInput) => Promise<void>;
    watchAllowed?: () => boolean;
  } = {},
) {
  const store = createInMemoryClickyStore();
  const written: { path: string; contents: string }[] = [];
  const hub = createClickyHub({ load: (u, b) => store.load(u, b) });
  const brain: ClickyBrain = options.brain ?? {
    async think(input) {
      return {
        type: "brain.reply",
        thinkId: input.thinkId,
        say: "Press Continue.",
        ...(input.session.mode === "act"
          ? {
              proposal: {
                action: {
                  kind: "click",
                  at: { x: 0.15, y: 0.25 },
                  ref: "e1",
                  label: "Continue",
                },
                why: "To go on.",
                risk: "low",
              },
            }
          : {}),
      };
    },
  };
  const service = createClickyService({
    store,
    hub,
    preferences,
    gateway: {
      elements: async () => screen,
      writeFile: async (_botId, _actor, input) => {
        written.push({ path: input.path, contents: input.contents });
        return {
          path: input.path,
          bytes: input.contents.length,
          appended: false,
        };
      },
    },
    brain,
    ...(options.actions ? { actions: options.actions } : {}),
    ...(options.audit ? { auditStore: { insert: options.audit } } : {}),
  });
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role: "user",
    });
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>().use("*", asActor).route(
    "/api/computers",
    createClickyRoutes({
      service,
      hub,
      ...(options.watchAllowed ? { watchAllowed: options.watchAllowed } : {}),
    }),
  );
  const command = async (body: unknown) => {
    const response = await app.request(
      "http://openbot.test/api/computers/bot-1/clicky/commands",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        session: ClickySession;
        rejected?: string;
        error?: string;
      },
    };
  };
  return { app, store, service, command, written };
}

async function until(check: () => boolean | Promise<boolean>, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await Bun.sleep(5);
  }
}

describe("GET /:botId/clicky", () => {
  test("answers a fresh, asleep session for this person and Bot", async () => {
    const { app } = harness();
    const response = await app.request(
      "http://openbot.test/api/computers/bot-1/clicky",
    );
    expect(response.status).toBe(200);
    const { session } = (await response.json()) as { session: ClickySession };
    expect(session).toMatchObject({
      botId: "bot-1",
      awake: false,
      state: "idle",
      seq: 0,
    });
  });
});

describe("POST /:botId/clicky/commands", () => {
  test("a body that does not hold together is a 400", async () => {
    const { command } = harness();
    for (const body of [
      "not json",
      {},
      { type: "dance" },
      { type: "wake", extra: true },
      { type: "ask" },
      { type: "ask", text: "x".repeat(2001) },
      { type: "approve", proposalId: "p", scope: "forever" },
      {
        type: "overlay.set",
        overlays: [{ kind: "pointer", id: "a", at: { x: 1.5, y: 0.5 } }],
      },
      {
        type: "overlay.set",
        overlays: [
          {
            kind: "highlight",
            id: "a",
            rect: { x: 0.9, y: 0.1, width: 0.5, height: 0.1 },
          },
        ],
      },
      {
        type: "overlay.set",
        overlays: Array.from({ length: 13 }, (_, index) => ({
          kind: "marker",
          id: `m${index}`,
          at: { x: 0.1, y: 0.1 },
          index,
        })),
      },
      {
        type: "activate",
        trigger: { kind: "takeover", targetRef: "not a ref!" },
      },
    ]) {
      const { status, body: answer } = await command(body);
      expect({ body, status }).toEqual({ body, status: 400 });
      expect(typeof answer.error).toBe("string");
    }
  });

  test("a refused command is a 200 with the notice to show", async () => {
    const { command } = harness();
    const next = await command({ type: "next" });
    expect(next.status).toBe(200);
    expect(next.body.rejected).toBe("no_step");
    const approve = await command({
      type: "approve",
      proposalId: "nothing-waiting",
      scope: "once",
    });
    expect(approve.status).toBe(200);
    expect(approve.body.rejected).toBe("expired");
  });

  test("a command changes the session and answers it", async () => {
    const { command } = harness();
    const woken = await command({ type: "wake" });
    expect(woken.status).toBe(200);
    expect(woken.body.session).toMatchObject({
      awake: true,
      seq: 1,
      reply: { notice: "awake" },
    });
    const drawn = await command({
      type: "overlay.set",
      overlays: [
        { kind: "pointer", id: "p1", at: { x: 0.2, y: 0.4 }, label: "Here" },
      ],
    });
    expect(drawn.body.session.state).toBe("guiding");
    expect(drawn.body.session.overlays).toHaveLength(1);
  });

  test("watch shows what the Bot is doing, as the person's own session", async () => {
    const { command } = harness();
    const watched = await command({ type: "watch" });
    expect(watched.status).toBe(200);
    expect(watched.body.session).toMatchObject({
      awake: true,
      narrating: true,
      state: "guiding",
      trigger: { kind: "person" },
      reply: { notice: "watching" },
    });
    expect((await command({ type: "watch", extra: 1 })).status).toBe(400);
  });

  test("a client's watch counts only while the Bot is at work for that person", async () => {
    let active = false;
    const { command } = harness({ watchAllowed: () => active });
    const idle = await command({ type: "watch" });
    expect(idle.status).toBe(200);
    expect(idle.body.rejected).toBeUndefined();
    expect(idle.body.session).toMatchObject({
      awake: false,
      narrating: false,
      seq: 0,
    });
    active = true;
    const working = await command({ type: "watch" });
    expect(working.body.session).toMatchObject({
      awake: true,
      narrating: true,
    });
  });

  test("asking looks at the screen and answers", async () => {
    const { command, store } = harness();
    const asked = await command({ type: "ask", text: "What next?" });
    expect(asked.body.session.state).toBe("thinking");
    await until(
      async () => (await store.load("user-1", "bot-1"))?.state === "idle",
    );
    const session = await store.load("user-1", "bot-1");
    expect(session?.reply?.text).toBe("Press Continue.");
    expect(session?.transcript.map((turn) => turn.role)).toEqual([
      "person",
      "clicky",
    ]);
  });

  test("Stop aborts an action in flight and drops its proposal", async () => {
    let started: AbortSignal | undefined;
    let finished = false;
    const actions: ClickyActions = {
      run: ({ signal }) =>
        new Promise((resolve) => {
          started = signal;
          signal.addEventListener("abort", () => {
            finished = true;
            resolve({ ok: false, detail: "Stopped." });
          });
        }),
    };
    const { command, store } = harness({ actions });
    await command({ type: "set_mode", mode: "act" });
    await command({ type: "ask", text: "Do it" });
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.state === "awaiting_permission",
    );
    const waiting = await store.load("user-1", "bot-1");
    const proposalId = waiting?.proposal?.id ?? "";
    expect(waiting?.proposal?.risk).toBe("low");

    const approved = await command({
      type: "approve",
      proposalId,
      scope: "once",
    });
    expect(approved.body.session.state).toBe("acting");
    await until(() => started !== undefined);
    expect(started?.aborted).toBe(false);

    const stopped = await command({ type: "stop" });
    expect(stopped.body.session).toMatchObject({
      state: "stopped",
      mode: "guide",
      proposal: null,
      grant: null,
      reply: { notice: "stopped" },
    });
    await until(() => finished);
    expect(started?.aborted).toBe(true);
    // The late failure of the stopped action changes nothing.
    await Bun.sleep(20);
    const after = await store.load("user-1", "bot-1");
    expect(after?.state).toBe("stopped");
    expect(after?.seq).toBe(stopped.body.session.seq);
  });

  test("an approved action runs, and Clicky says it is done", async () => {
    let ran = 0;
    const actions: ClickyActions = {
      run: async () => {
        ran += 1;
        return { ok: true };
      },
    };
    const { command, store } = harness({ actions });
    await command({ type: "set_mode", mode: "act" });
    await command({ type: "ask", text: "Do it" });
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.state === "awaiting_permission",
    );
    const proposalId =
      (await store.load("user-1", "bot-1"))?.proposal?.id ?? "";
    await command({ type: "approve", proposalId, scope: "once" });
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.reply?.notice === "action_done",
    );
    expect(ran).toBe(1);
  });
});

describe("save_notes", () => {
  test("writes the session's notes into the Bot's workspace and says so", async () => {
    const { command, store, written } = harness();
    await command({ type: "ask", text: "What next?" });
    await until(
      async () => (await store.load("user-1", "bot-1"))?.state === "idle",
    );
    const asked = await command({ type: "save_notes" });
    // Nothing changes until the notes are written; then Clicky says where.
    expect(asked.status).toBe(200);
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.reply?.notice === "notes_saved",
    );
    const session = await store.load("user-1", "bot-1");
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toMatch(
      new RegExp(`^clicky-notes/\\d{4}-\\d{2}-\\d{2}-${session?.id}\\.md$`),
    );
    expect(written[0]?.contents).toContain("**Person:** What next?");
    expect(written[0]?.contents).toContain("**Show me how:** Press Continue.");
    expect(session?.reply?.text).toBe(written[0]?.path);
  });
});

describe("POST /:botId/clicky/guide", () => {
  test("installs the Bot's walkthrough, pointed at the refs on screen", async () => {
    const { app } = harness();
    const response = await app.request(
      "http://openbot.test/api/computers/bot-1/clicky/guide",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: "Check out",
          steps: [
            { say: "Press Continue.", ref: "e1" },
            { say: "Then wait.", ref: "e99" },
          ],
        }),
      },
    );
    expect(response.status).toBe(200);
    const { session } = (await response.json()) as { session: ClickySession };
    expect(session.awake).toBe(true);
    expect(session.state).toBe("guiding");
    expect(session.walkthrough?.goal).toBe("Check out");
    const [first, second] = session.walkthrough?.steps ?? [];
    expect(first).toMatchObject({
      title: "Press Continue.",
      status: "current",
      targetRef: "e1",
    });
    expect(first?.overlays.map((overlay) => overlay.kind)).toEqual([
      "highlight",
      "pointer",
    ]);
    expect(second?.overlays).toEqual([]);
    expect(session.reply?.text).toBe("Press Continue.");
  });

  test("refuses a walkthrough with no steps or too many", async () => {
    const { app } = harness();
    for (const steps of [
      [],
      Array.from({ length: 9 }, () => ({ say: "Step." })),
    ]) {
      const response = await app.request(
        "http://openbot.test/api/computers/bot-1/clicky/guide",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: "x", steps }),
        },
      );
      expect(response.status).toBe(400);
    }
  });
});

describe("the security round", () => {
  test("a client opens Clicky for the person only; the Bot's needs come from the server", async () => {
    const { command } = harness();
    for (const kind of [
      "takeover",
      "sign_in",
      "secret",
      "challenge",
      "approval",
    ]) {
      const refused = await command({
        type: "activate",
        trigger: { kind, requestId: "r1", reason: "Pay now" },
      });
      expect({ kind, status: refused.status }).toEqual({ kind, status: 400 });
    }
    const person = await command({
      type: "activate",
      trigger: { kind: "person", reason: "Help me here" },
    });
    expect(person.status).toBe(200);
    expect(person.body.session.trigger?.kind).toBe("person");
  });

  test("looks come five at a time, then a moment's wait", async () => {
    let looks = 0;
    const { command } = harness({
      brain: {
        think: async (input) => {
          looks += 1;
          return { type: "brain.reply", thinkId: input.thinkId, say: "Here." };
        },
      },
    });
    const answers: (string | undefined)[] = [];
    for (let index = 0; index < 7; index += 1)
      answers.push(
        (await command({ type: "ask", text: `q${index}` })).body.rejected,
      );
    expect(answers.slice(0, 5)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(answers.slice(5)).toEqual(["busy", "busy"]);
    await Bun.sleep(20);
    expect(looks).toBeLessThanOrEqual(5);
  });

  test("an action whose approval could not be written to the trail is not done", async () => {
    let ran = 0;
    const { command, store } = harness({
      actions: {
        run: async () => {
          ran += 1;
          return { ok: true, audit: {} };
        },
      },
      audit: async (row) => {
        if (row.eventType === "clicky.action_approved")
          throw new Error("the trail is down");
      },
    });
    await command({ type: "set_mode", mode: "act" });
    await command({ type: "ask", text: "Do it" });
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.state === "awaiting_permission",
    );
    const proposalId =
      (await store.load("user-1", "bot-1"))?.proposal?.id ?? "";
    await command({ type: "approve", proposalId, scope: "once" });
    await until(
      async () =>
        (await store.load("user-1", "bot-1"))?.reply?.notice ===
        "action_failed",
    );
    expect(ran).toBe(0);
    expect((await store.load("user-1", "bot-1"))?.error?.detail).toContain(
      "recorded",
    );
  });

  test("a walkthrough the Bot installs is on the trail", async () => {
    const rows: AuditEventInput[] = [];
    const { app } = harness({
      audit: async (row) => {
        rows.push(row);
      },
    });
    await app.request("http://openbot.test/api/computers/bot-1/clicky/guide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "Check out",
        steps: [{ say: "Press Continue.", ref: "e1" }],
      }),
    });
    expect(
      rows.find((row) => row.eventType === "clicky.guide_installed"),
    ).toMatchObject({
      targetId: "bot-1",
      payload: { steps: 1, pointed: 1, missing: 0 },
    });
  });
});
