import { afterAll, describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { ClickyServerEvent, ClickySession } from "../../shared/clicky";
import { reduceClicky } from "../../shared/clicky-state";
import { createClickyHub } from "../src/clicky/hub";
import { createClickyRoutes } from "../src/clicky/routes";
import {
  type ClickyPreferences,
  createClickyService,
} from "../src/clicky/service";
import {
  type ClickyStore,
  createInMemoryClickyStore,
} from "../src/clicky/store";
import type { AppVariables } from "../src/auth/guards";
import { websocket } from "../src/channels/socket";

/*
 * Two screens on one session (the web app's Clicky bar and the phone) see the same changes in the
 * same order, and a write that lost a race is reduced again on what won rather than written over it.
 */

const preferences = async (): Promise<ClickyPreferences> => ({
  locale: "en",
  guidance: "brief",
  actionPolicy: "ask_each",
  autoActivate: true,
});

const gateway = {
  elements: async () => ({
    screen: { width: 1000, height: 500 },
    mode: "page" as const,
    url: "",
    elements: [],
  }),
  writeFile: async () => ({ path: "", bytes: 0, appended: false }),
};

function serve(store: ClickyStore) {
  const hub = createClickyHub({ load: (u, b) => store.load(u, b) });
  const service = createClickyService({ store, hub, preferences, gateway });
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
  const app = new Hono<{ Variables: AppVariables }>()
    .use("*", asActor)
    .route("/api/computers", createClickyRoutes({ service, hub }));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, bun) => app.fetch(request, { server: bun }),
    websocket,
  });
  return { server, service, hub };
}

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
});

function listen(url: string) {
  const events: ClickyServerEvent[] = [];
  const socket = new WebSocket(url);
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) =>
    events.push(JSON.parse(String(event.data)) as ClickyServerEvent),
  );
  return { socket, events, opened };
}

async function until(check: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await Bun.sleep(5);
  }
}

const seqs = (events: ClickyServerEvent[]) =>
  events.flatMap((event) =>
    event.type === "snapshot" ? [event.session.seq] : [],
  );

describe("the events socket", () => {
  test("two subscribers get the same snapshots, in order", async () => {
    const store = createInMemoryClickyStore();
    const { server, service } = serve(store);
    servers.push(server);
    const url = `ws://127.0.0.1:${server.port}/api/computers/bot-1/clicky/events`;
    const web = listen(url);
    const phone = listen(url);
    await Promise.all([web.opened, phone.opened]);
    // Each is sent the session as it is on opening.
    await until(() => web.events.length >= 1 && phone.events.length >= 1);
    expect(web.events[0]).toMatchObject({ type: "snapshot" });

    for (const command of [
      { type: "wake" },
      { type: "overlay.set", overlays: [] },
      { type: "pause" },
      { type: "resume" },
    ] as const)
      await service.dispatch("user-1", "bot-1", { type: "command", command });

    await until(
      () => seqs(web.events).includes(4) && seqs(phone.events).includes(4),
    );
    expect(seqs(web.events)).toEqual([0, 1, 2, 3, 4]);
    expect(seqs(phone.events)).toEqual(seqs(web.events));

    // A Bot's other person, or another Bot's session, is not on this socket.
    await service.dispatch("user-2", "bot-1", {
      type: "command",
      command: { type: "wake" },
    });
    await service.dispatch("user-1", "bot-2", {
      type: "command",
      command: { type: "wake" },
    });
    await Bun.sleep(30);
    expect(seqs(web.events)).toEqual([0, 1, 2, 3, 4]);
    web.socket.close();
    phone.socket.close();
  });

  test("the reply streams to the socket while the model is still answering", async () => {
    const store = createInMemoryClickyStore();
    const hub = createClickyHub({ load: (u, b) => store.load(u, b) });
    const seen: ClickyServerEvent[] = [];
    hub.subscribe("user-1", "bot-1", (event) => seen.push(event));
    hub.delta("user-1", "bot-1", 3, "Hel");
    hub.delta("user-1", "bot-1", 3, "lo");
    hub.delta("user-1", "bot-1", 3, "");
    expect(seen).toEqual([
      { type: "reply.delta", seq: 3, text: "Hel" },
      { type: "reply.delta", seq: 3, text: "lo" },
    ]);
    hub.resyncAll();
    expect(seen.at(-1)).toEqual({ type: "resync" });
  });

  test("an announcement from another replica is read back once, and an echo is not sent twice", async () => {
    const store = createInMemoryClickyStore();
    const announced: unknown[] = [];
    const hub = createClickyHub({
      load: (u, b) => store.load(u, b),
      announce: async (note) => {
        announced.push(note);
      },
    });
    const seen: ClickyServerEvent[] = [];
    hub.subscribe("user-1", "bot-1", (event) => seen.push(event));
    const { session } = await store.open("user-1", "bot-1", Date.now());
    hub.publish("user-1", "bot-1", session);
    await hub.hear({ userId: "user-1", botId: "bot-1", seq: 0 });
    expect(seqs(seen)).toEqual([0]);
    expect(announced).toEqual([{ userId: "user-1", botId: "bot-1", seq: 0 }]);
    // Another replica wrote seq 1; this one hears of it and reads it back.
    const woken = reduceClicky(
      session,
      { type: "command", command: { type: "wake" } },
      { now: Date.now(), actionPolicy: "ask_each", newId: () => "x" },
    ).session;
    await store.save("user-1", "bot-1", woken, 0);
    await hub.hear({ userId: "user-1", botId: "bot-1", seq: 1 });
    expect(seqs(seen)).toEqual([0, 1]);
  });
});

describe("compare-and-set", () => {
  test("a write that lost the race is reduced again on the winner", async () => {
    const memory = createInMemoryClickyStore();
    let raced = false;
    const racing: ClickyStore = {
      load: memory.load,
      open: memory.open,
      async save(userId, botId, session, expectedSeq) {
        if (!raced) {
          raced = true;
          // Another replica gets in first, between this one's read and its write.
          const current = (await memory.load(userId, botId)) as ClickySession;
          const theirs = reduceClicky(
            current,
            {
              type: "command",
              command: {
                type: "overlay.set",
                overlays: [
                  { kind: "pointer", id: "theirs", at: { x: 0.5, y: 0.5 } },
                ],
              },
            },
            { now: Date.now(), actionPolicy: "ask_each", newId: () => "t" },
          ).session;
          await memory.save(userId, botId, theirs, current.seq);
        }
        return memory.save(userId, botId, session, expectedSeq);
      },
    };
    const hub = createClickyHub({ load: (u, b) => memory.load(u, b) });
    const service = createClickyService({
      store: racing,
      hub,
      preferences,
      gateway,
    });
    const outcome = await service.dispatch("user-1", "bot-1", {
      type: "command",
      command: { type: "pause" },
    });
    expect(raced).toBe(true);
    const stored = await memory.load("user-1", "bot-1");
    // Both changes are there: the other replica's pointer, and this one's pause on top of it.
    expect(stored?.seq).toBe(2);
    expect(stored?.state).toBe("paused");
    expect(stored?.overlays.map((overlay) => overlay.id)).toEqual(["theirs"]);
    expect(outcome?.session).toEqual(stored as ClickySession);
  });

  test("a session left past the resume window starts over", async () => {
    const store = createInMemoryClickyStore();
    const { session: first } = await store.open("user-1", "bot-1", 0);
    const later = Date.parse(first.updatedAt) + 31 * 60_000;
    const { session: second, created } = await store.open(
      "user-1",
      "bot-1",
      later,
    );
    expect(created).toBe(true);
    expect(second.id).not.toBe(first.id);
    const { session: again } = await store.open(
      "user-1",
      "bot-1",
      later + 60_000,
    );
    expect(again.id).toBe(second.id);
  });
});
