import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { isClickyStopShortcut } from "@/lib/clicky/keyboard";
import { keepClickySession, postClickyGuide } from "@/lib/clicky/mutations";
import { CLICKY_NOTICE_KEYS, replyText } from "@/lib/clicky/notices";
import { clickyKeys, newerSession } from "@/lib/clicky/queries";
import {
  applyReplyDelta,
  selectClickyPresence,
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
 * it current. Snapshots are ordered by `seq` and a late one never replaces a newer one; the pieces
 * of an answer start a reply of their own (the thinking snapshot still carries the last, whole one)
 * and are appended once a frame; a piece for a snapshot this tab never saw, or a `resync`, fetches the
 * session again; one socket is shared by everything showing the same Bot, and a surface that reads
 * only where Clicky is is not drawn again for each word.
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
let guideAnswer: () => Response = () => Response.json({});
const originalFetch = globalThis.fetch;
let originalWebSocket: typeof WebSocket;

/** Clicky awake, as a wake leaves it: the greeting is the reply, whole. */
function at(seq: number, patch: Partial<ClickySession> = {}): ClickySession {
  return {
    ...newClickySession({ id: "s1", botId: BOT, now: 0 }),
    awake: true,
    reply: { text: "", final: true, notice: "awake" },
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
    if (url === `/api/computers/${BOT}/clicky/guide`) return guideAnswer();
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
  shown = useClickySession(BOT, true, surface);
  return null;
}

async function mounted(first: ClickySession = at(1)) {
  served = first;
  const view = render(<Probe />);
  await waitFor(() => expect(shown?.seq).toBe(first.seq));
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

test("the newest copy wins, and on a tie a reply still arriving is kept", () => {
  expect(newerSession(at(3), at(2)).seq).toBe(3);
  expect(newerSession(at(3), at(4)).seq).toBe(4);
  expect(newerSession(undefined, at(1)).seq).toBe(1);
  // Another session (an old one expired) is simply the one to show now.
  expect(newerSession(at(9), { ...at(1), id: "s2" }).id).toBe("s2");
  const streaming = at(5, {
    state: "thinking",
    reply: { text: "Hello there", final: false },
  });
  // What a refused command's answer or a reconnect's snapshot says at the same seq: the old reply.
  const before = at(5, { state: "thinking" });
  expect(newerSession(streaming, before)).toBe(streaming);
  // Without words arriving, the incoming copy of a tie is taken.
  expect(newerSession(before, at(5, { state: "guiding" })).state).toBe(
    "guiding",
  );
});

test("the first piece of an answer starts a new reply; the rest are appended to it", () => {
  // Thinking, with the greeting still there, whole: the answer's first piece replaces it.
  const thinking = at(4, { state: "thinking" });
  const started = applyReplyDelta(thinking, { seq: 4, text: "Cli" });
  expect(
    started !== null && started !== "refetch" ? started.reply : null,
  ).toEqual({ text: "Cli", final: false });
  const more =
    started !== null && started !== "refetch"
      ? applyReplyDelta(started, { seq: 4, text: "ck" })
      : null;
  expect(more !== null && more !== "refetch" ? more.reply?.text : null).toBe(
    "Click",
  );
  // Late, ahead, or for a session no longer thinking: dropped, fetched again, dropped.
  expect(applyReplyDelta(thinking, { seq: 3, text: "late" })).toBeNull();
  expect(applyReplyDelta(thinking, { seq: 6, text: "ahead" })).toBe("refetch");
  expect(
    applyReplyDelta(at(4, { state: "guiding" }), { seq: 4, text: "!" }),
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

test("an answer streams in after a wake's greeting, and a same-seq answer does not wipe it", async () => {
  const { socket } = await mounted();
  // Asked: thinking, with the greeting still the reply, as the reducer leaves it.
  socket.emit({ type: "snapshot", session: at(2, { state: "thinking" }) });
  await waitFor(() => expect(shown?.state).toBe("thinking"));

  socket.emit({ type: "reply.delta", seq: 2, text: "Click " });
  socket.emit({ type: "reply.delta", seq: 2, text: "Sign in." });
  await waitFor(() => expect(shown?.reply?.text).toBe("Click Sign in."));
  expect(shown?.reply?.final).toBe(false);
  expect(shown?.reply?.notice).toBeUndefined();

  // A refused command's answer carries the session at that seq, greeting and all: kept out.
  act(() => keepClickySession(queryClient, BOT, at(2, { state: "thinking" })));
  expect(shown?.reply?.text).toBe("Click Sign in.");
  // So is the snapshot a reconnect would send.
  socket.emit({ type: "snapshot", session: at(2, { state: "thinking" }) });
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

test("the same works after an activation, whose reply is the Bot's request", async () => {
  const { socket } = await mounted(
    at(6, {
      state: "thinking",
      trigger: { kind: "takeover", requestId: "r1", reason: "Sign in." },
      reply: { text: "Sign in.", final: true, notice: "takeover" },
    }),
  );
  socket.emit({ type: "reply.delta", seq: 6, text: "Top right." });
  await waitFor(() => expect(shown?.reply?.text).toBe("Top right."));
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

test("a surface that reads only where Clicky is, is not drawn again while words arrive", async () => {
  const { socket } = await mounted();
  let renders = 0;
  let presence: { awake: boolean; state: string } | undefined;
  function Presence() {
    renders += 1;
    presence = useClickySession(BOT, true, "preview", selectClickyPresence);
    return null;
  }
  render(<Presence />);
  socket.emit({ type: "snapshot", session: at(2, { state: "thinking" }) });
  await waitFor(() => expect(presence?.state).toBe("thinking"));
  const before = renders;

  for (const word of ["One ", "two ", "three ", "four."])
    socket.emit({ type: "reply.delta", seq: 2, text: word });
  await waitFor(() => expect(shown?.reply?.text).toBe("One two three four."));
  expect(renders).toBe(before);
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

test("a guide the session refused is reported to the Bot as not shown", async () => {
  guideAnswer = () => Response.json({ session: at(2), rejected: "busy" });
  expect(
    await postClickyGuide(BOT, { goal: "Sign in", steps: [{ say: "Click" }] }),
  ).toEqual({
    ok: false,
    reason:
      "Clicky could not show this right now; describe the steps in words.",
  });
  guideAnswer = () => Response.json({ session: at(2) });
  expect((await postClickyGuide(BOT, { goal: "x", steps: [] })).ok).toBe(true);
});

test("AltGr is not the Stop shortcut, even though it reports Control and Alt", () => {
  const key = (altGraph: boolean) =>
    ({
      key: "ś",
      code: "KeyS",
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      getModifierState: (name: string) => altGraph && name === "AltGraph",
    }) as unknown as KeyboardEvent;
  expect(isClickyStopShortcut(key(false))).toBe(true);
  expect(isClickyStopShortcut(key(true))).toBe(false);
});
