import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { CLICKY_NOTICE_KEYS, replyText } from "@/lib/clicky/notices";
import { clickyKeys, newerSession } from "@/lib/clicky/queries";
import {
  applyReplyDelta,
  useClickySession,
} from "@/lib/clicky/use-clicky-session";
import { queryClient } from "@/query-client";
import {
  CLICKY_NOTICE_TEXT,
  CLICKY_NOTICES,
  type ClickySession,
  newClickySession,
} from "../../shared/clicky";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot's Clicky session in the browser: the GET for the first copy, then the events socket keeping
 * it current. Snapshots are ordered by `seq` and a late one never replaces a newer one; pieces of a
 * reply arriving are appended; a piece for a snapshot this tab never saw, or a `resync`, fetches the
 * session again; one socket is shared by everything showing the same Bot.
 */

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: SocketDouble[] = [];
  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    SocketDouble.all.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send() {}
  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
  /** The server sending something. */
  emit(message: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(message) }));
  }
}

const BOT = "session-bot";
let served: ClickySession;
let gets = 0;
const originalFetch = globalThis.fetch;
let originalWebSocket: typeof WebSocket;

function at(seq: number, patch: Partial<ClickySession> = {}): ClickySession {
  return {
    ...newClickySession({ id: "s1", botId: BOT, now: 0 }),
    awake: true,
    seq,
    ...patch,
  };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Whatever an earlier file left in the shared cache (a signed-out person, say) is not ours.
  queryClient.clear();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/computers/${BOT}/clicky`) {
      gets += 1;
      return Response.json({ session: served });
    }
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  SocketDouble.all = [];
  gets = 0;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

let shown: ClickySession | undefined;
function Probe({ surface }: { surface?: "viewer" | "preview" }) {
  shown = useClickySession(BOT, true, surface).data;
  return null;
}

async function mounted() {
  served = at(1, { reply: { text: "Hi", final: true } });
  const view = render(<Probe />);
  await waitFor(() => expect(shown?.seq).toBe(1));
  await waitFor(() => expect(SocketDouble.all).toHaveLength(1));
  const socket = SocketDouble.all[0] as SocketDouble;
  expect(socket.url).toBe(`ws://localhost/api/computers/${BOT}/clicky/events`);
  return { view, socket };
}

test("every notice the server can send has the same English here, as a translation key", () => {
  for (const notice of CLICKY_NOTICES)
    expect(CLICKY_NOTICE_KEYS[notice]).toBe(CLICKY_NOTICE_TEXT[notice]);
});

test("a reply reads Clicky's fixed line and then the model's words", () => {
  const t = (key: string) => key;
  expect(replyText({ text: "", final: true, notice: "paused" }, t)).toBe(
    "Paused.",
  );
  expect(
    replyText({ text: "Please sign in.", final: true, notice: "takeover" }, t),
  ).toBe("Noë Bot needs you here. Please sign in.");
  expect(replyText({ text: "Click Next.", final: false }, t)).toBe(
    "Click Next.",
  );
  // A saved note's text is its path, not something to read.
  expect(
    replyText(
      { text: "notes/clicky.md", final: true, notice: "notes_saved" },
      t,
    ),
  ).toBe("Notes saved.");
});

test("the newest copy wins, and a reply still arriving is not cut back", () => {
  expect(newerSession(at(3), at(2)).seq).toBe(3);
  expect(newerSession(at(3), at(4)).seq).toBe(4);
  expect(newerSession(undefined, at(1)).seq).toBe(1);
  // Another session (an old one expired) is simply the one to show now.
  expect(newerSession(at(9), { ...at(1), id: "s2" }).id).toBe("s2");
  const longer = at(5, { reply: { text: "Hello there", final: false } });
  const shorter = at(5, { reply: { text: "Hello", final: false } });
  expect(newerSession(longer, shorter)).toBe(longer);
});

test("a delta appends to the reply it belongs to, and asks again for one it does not know", () => {
  const streaming = at(4, { reply: { text: "Cli", final: false } });
  const next = applyReplyDelta(streaming, { seq: 4, text: "ck" });
  expect(next !== null && next !== "refetch" ? next.reply?.text : null).toBe(
    "Click",
  );
  expect(applyReplyDelta(streaming, { seq: 3, text: "late" })).toBeNull();
  expect(applyReplyDelta(streaming, { seq: 6, text: "ahead" })).toBe("refetch");
  expect(
    applyReplyDelta(at(4, { reply: { text: "Done", final: true } }), {
      seq: 4,
      text: "!",
    }),
  ).toBeNull();
});

test("snapshots are kept in seq order; an older one arriving late is ignored", async () => {
  const { socket } = await mounted();

  socket.emit({ type: "snapshot", session: at(3, { state: "guiding" }) });
  await waitFor(() => expect(shown?.seq).toBe(3));
  expect(shown?.state).toBe("guiding");

  socket.emit({ type: "snapshot", session: at(2, { state: "thinking" }) });
  expect(shown?.seq).toBe(3);
  expect(shown?.state).toBe("guiding");

  // Garbage on the socket is ignored rather than thrown.
  act(() => socket.onmessage?.({ data: "not json" }));
  socket.emit({ type: "snapshot" });
  expect(shown?.seq).toBe(3);
});

test("reply pieces accumulate while the reply streams, then the final snapshot replaces them", async () => {
  const { socket } = await mounted();
  socket.emit({
    type: "snapshot",
    session: at(2, { state: "thinking", reply: { text: "", final: false } }),
  });
  await waitFor(() => expect(shown?.seq).toBe(2));

  socket.emit({ type: "reply.delta", seq: 2, text: "Click " });
  socket.emit({ type: "reply.delta", seq: 2, text: "Sign in." });
  await waitFor(() => expect(shown?.reply?.text).toBe("Click Sign in."));
  expect(shown?.reply?.final).toBe(false);

  // A pieces-only copy of the same seq (the open snapshot, say) does not undo what arrived.
  socket.emit({
    type: "snapshot",
    session: at(2, { state: "thinking", reply: { text: "Cli", final: false } }),
  });
  expect(shown?.reply?.text).toBe("Click Sign in.");

  socket.emit({
    type: "snapshot",
    session: at(3, {
      state: "guiding",
      reply: { text: "Click Sign in.", final: true },
    }),
  });
  await waitFor(() => expect(shown?.reply?.final).toBe(true));
});

test("a piece for a snapshot never seen, and a resync, fetch the session again", async () => {
  const { socket } = await mounted();
  expect(gets).toBe(1);

  served = at(7, { state: "guiding" });
  socket.emit({ type: "reply.delta", seq: 7, text: "ahead" });
  await waitFor(() => expect(gets).toBe(2));
  await waitFor(() => expect(shown?.seq).toBe(7));

  served = at(8, { state: "idle" });
  socket.emit({ type: "resync" });
  await waitFor(() => expect(gets).toBe(3));
  await waitFor(() => expect(shown?.seq).toBe(8));
});

test("a dropped socket reconnects and fetches the session again", async () => {
  const { socket } = await mounted();
  served = at(4, { state: "guiding" });
  act(() => socket.close());

  await waitFor(() => expect(SocketDouble.all).toHaveLength(2), {
    timeout: 3_000,
  });
  await waitFor(() => expect(gets).toBe(2));
  await waitFor(() => expect(shown?.seq).toBe(4));
});

test("everything showing one Bot shares one socket, closed with the last of them", async () => {
  served = at(1);
  const first = render(<Probe surface="viewer" />);
  const second = render(<Probe surface="preview" />);
  await waitFor(() => expect(shown?.seq).toBe(1));
  await waitFor(() => expect(SocketDouble.all).toHaveLength(1));
  const socket = SocketDouble.all[0] as SocketDouble;

  first.unmount();
  expect(socket.readyState).toBe(SocketDouble.OPEN);
  second.unmount();
  expect(socket.readyState).toBe(SocketDouble.CLOSED);
  expect(queryClient.getQueryData(clickyKeys.session(BOT))).toBeDefined();
});
