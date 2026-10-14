import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { isClickyStopShortcut } from "@/lib/clicky/keyboard";
import { keepClickySession, postClickyGuide } from "@/lib/clicky/mutations";
import { CLICKY_NOTICE_KEYS, replyText } from "@/lib/clicky/notices";
import { clickyKeys, newerSession } from "@/lib/clicky/queries";
import {
  acceptReplyDelta,
  type ClickyStream,
  selectClickyPresence,
  shownReply,
  streamAfterSnapshot,
  useClickyReply,
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
 * it current. Snapshots are ordered by `seq` and a late one never replaces a newer one. The words of
 * an answer still arriving are kept apart, keyed by the session and the model call (`thinkId`) they
 * belong to: shown while that session thinks on that call (the session's own reply until then is the
 * previous one, whole), kept across a `seq` that moves mid-answer, never shown in another session.
 * A piece for a snapshot never seen, or a `resync`, fetches the session again; one socket is shared
 * by everything showing the same Bot, and only the reply line is drawn again for each word.
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
let reply: ClickySession["reply"] | undefined;
function Probe({ surface }: { surface?: "viewer" | "preview" }) {
  shown = useClickySession(BOT, true, surface);
  reply = useClickyReply(BOT);
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

test("the newest copy wins; a tie takes the incoming copy", () => {
  expect(newerSession(at(3), at(2)).seq).toBe(3);
  expect(newerSession(at(3), at(4)).seq).toBe(4);
  expect(newerSession(undefined, at(1)).seq).toBe(1);
  // Another session (an old one expired) is simply the one to show now, whatever its seq.
  expect(newerSession(at(9), { ...at(0), id: "s2" }).id).toBe("s2");
  expect(newerSession(at(5), at(5, { state: "guiding" })).state).toBe(
    "guiding",
  );
});

test("pieces count for the call the session waits on, or for a snapshot not seen yet", () => {
  const thinking = at(4, { state: "thinking", thinkId: "t1" });
  const first = acceptReplyDelta(thinking, null, {
    seq: 4,
    thinkId: "t1",
    text: "Cli",
  });
  expect(first).toEqual({
    stream: { sessionId: "s1", thinkId: "t1", text: "Cli" },
    refetch: false,
  });
  expect(
    acceptReplyDelta(thinking, first.stream, {
      seq: 4,
      thinkId: "t1",
      text: "ck",
    }).stream?.text,
  ).toBe("Click");
  // Another call, at a seq already seen: nobody is waiting on it.
  expect(
    acceptReplyDelta(thinking, first.stream, {
      seq: 4,
      thinkId: "t0",
      text: "late",
    }),
  ).toEqual({ stream: first.stream, refetch: false });
  // Ahead of the snapshot that starts the call: kept, and the snapshot fetched.
  const ahead = acceptReplyDelta(at(4, { state: "guiding" }), null, {
    seq: 5,
    thinkId: "t2",
    text: "Next",
  });
  expect(ahead).toEqual({
    stream: { sessionId: "s1", thinkId: "t2", text: "Next" },
    refetch: true,
  });
  // A new call starts its own words rather than adding to the last call's.
  expect(
    acceptReplyDelta(
      at(6, { state: "thinking", thinkId: "t3" }),
      ahead.stream,
      { seq: 6, thinkId: "t3", text: "Hi" },
    ).stream,
  ).toEqual({ sessionId: "s1", thinkId: "t3", text: "Hi" });
  // No session yet: nothing to key the words by; it is fetched.
  expect(
    acceptReplyDelta(undefined, null, { seq: 1, thinkId: "t1", text: "x" }),
  ).toEqual({ stream: null, refetch: true });
});

test("the words shown are the answer arriving, only while that session thinks on that call", () => {
  const stream: ClickyStream = { sessionId: "s1", thinkId: "t1", text: "Top" };
  // Thinking, the greeting still the session's reply, whole: the words arriving win.
  const greeting = { text: "", final: true, notice: "awake" as const };
  const thinking = at(4, { state: "thinking", thinkId: "t1", reply: greeting });
  expect(shownReply(thinking, stream)).toEqual({ text: "Top", final: false });
  // No words yet: the greeting stays.
  expect(shownReply(thinking, { ...stream, text: "" })).toBe(greeting);
  // Answered: the session's own reply.
  expect(shownReply({ ...thinking, state: "guiding" }, stream)).toBe(greeting);
  // Another call, or another session: never these words.
  expect(shownReply({ ...thinking, thinkId: "t2" }, stream)).toBe(greeting);
  expect(shownReply({ ...thinking, id: "s2" }, stream)).toBe(greeting);
});

test("a snapshot keeps the words only for the same session, the same call, still thinking", () => {
  const stream: ClickyStream = { sessionId: "s1", thinkId: "t1", text: "Top" };
  // Clicky's first pointer, mid-answer: a later seq of the same call keeps the beginning.
  expect(
    streamAfterSnapshot(stream, at(9, { state: "thinking", thinkId: "t1" })),
  ).toBe(stream);
  expect(
    streamAfterSnapshot(stream, at(9, { state: "guiding", thinkId: null })),
  ).toBeNull();
  expect(
    streamAfterSnapshot(stream, at(9, { state: "thinking", thinkId: "t2" })),
  ).toBeNull();
  expect(
    streamAfterSnapshot(stream, {
      ...at(0, { state: "thinking", thinkId: "t1" }),
      id: "s2",
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

test("while thinking, the greeting is held until the answer's first words, which then stream", async () => {
  const { socket } = await mounted();
  // Asked: thinking on call t1, the greeting still the reply, whole, as the reducer leaves it.
  socket.emit({
    type: "snapshot",
    session: at(2, { state: "thinking", thinkId: "t1" }),
  });
  await waitFor(() => expect(shown?.state).toBe("thinking"));
  expect(reply).toEqual({ text: "", final: true, notice: "awake" });

  socket.emit({ type: "reply.delta", seq: 2, thinkId: "t1", text: "Click " });
  socket.emit({ type: "reply.delta", seq: 2, thinkId: "t1", text: "Sign in." });
  await waitFor(() =>
    expect(reply).toEqual({ text: "Click Sign in.", final: false }),
  );
  // The cache holds only what the server sent: a refused command's answer at the same seq changes
  // nothing of the words arriving.
  expect(shown?.reply?.notice).toBe("awake");
  act(() =>
    keepClickySession(
      queryClient,
      BOT,
      at(2, { state: "thinking", thinkId: "t1" }),
    ),
  );
  expect(reply?.text).toBe("Click Sign in.");

  // The answer: the session's own, whole reply.
  socket.emit({
    type: "snapshot",
    session: at(3, {
      state: "guiding",
      reply: { text: "Click Sign in.", final: true },
    }),
  });
  await waitFor(() => expect(reply?.final).toBe(true));
});

test("a seq that moves mid-answer (Clicky's first pointer) keeps the beginning", async () => {
  const { socket } = await mounted(
    at(6, {
      state: "thinking",
      thinkId: "t1",
      trigger: { kind: "takeover", requestId: "r1", reason: "Sign in." },
      reply: { text: "Sign in.", final: true, notice: "takeover" },
    }),
  );
  socket.emit({ type: "reply.delta", seq: 6, thinkId: "t1", text: "Top " });
  await waitFor(() => expect(reply?.text).toBe("Top "));

  // The deterministic first pointer: a snapshot of its own, the same call still answering.
  socket.emit({
    type: "snapshot",
    session: at(7, {
      state: "thinking",
      thinkId: "t1",
      overlays: [{ kind: "pointer", id: "p", at: { x: 0.9, y: 0.1 } }],
      reply: { text: "Sign in.", final: true, notice: "takeover" },
    }),
  });
  await waitFor(() => expect(shown?.seq).toBe(7));
  socket.emit({ type: "reply.delta", seq: 7, thinkId: "t1", text: "right." });
  await waitFor(() =>
    expect(reply).toEqual({ text: "Top right.", final: false }),
  );
});

test("a session started afresh, its seq back at zero, never shows the old words", async () => {
  const { socket } = await mounted(at(8, { state: "thinking", thinkId: "t1" }));
  socket.emit({
    type: "reply.delta",
    seq: 8,
    thinkId: "t1",
    text: "Old words",
  });
  await waitFor(() => expect(reply?.text).toBe("Old words"));

  // The old session expired; a new one starts at seq 0, thinking on a call of the same name.
  socket.emit({
    type: "snapshot",
    session: {
      ...at(0, { state: "thinking", thinkId: "t1" }),
      id: "s2",
      reply: null,
    },
  });
  await waitFor(() => expect(shown?.id).toBe("s2"));
  expect(reply).toBeNull();
  // Its own words start from nothing.
  socket.emit({ type: "reply.delta", seq: 0, thinkId: "t1", text: "New" });
  await waitFor(() => expect(reply).toEqual({ text: "New", final: false }));
});

test("words for a call nobody waits on any more are dropped", async () => {
  const { socket } = await mounted(at(3, { state: "thinking", thinkId: "t2" }));
  socket.emit({ type: "reply.delta", seq: 3, thinkId: "t1", text: "stale" });
  socket.emit({ type: "reply.delta", seq: 3, thinkId: "t2", text: "fresh" });
  await waitFor(() => expect(reply?.text).toBe("fresh"));
});

test("words ahead of their snapshot are kept, and the snapshot fetched", async () => {
  const { socket } = await mounted(at(4, { state: "guiding" }));
  served = at(5, { state: "thinking", thinkId: "t9" });
  socket.emit({ type: "reply.delta", seq: 5, thinkId: "t9", text: "Early" });
  await waitFor(() => expect(gets).toBe(2));
  await waitFor(() => expect(shown?.seq).toBe(5));
  await waitFor(() => expect(reply).toEqual({ text: "Early", final: false }));
});

test("a piece for a snapshot never seen, and a resync, fetch the session again", async () => {
  const { socket } = await mounted();
  expect(gets).toBe(1);

  served = at(7, { state: "guiding" });
  socket.emit({ type: "reply.delta", seq: 7, thinkId: "t7", text: "ahead" });
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
  socket.emit({
    type: "snapshot",
    session: at(2, { state: "thinking", thinkId: "t1" }),
  });
  await waitFor(() => expect(presence?.state).toBe("thinking"));
  const before = renders;

  for (const word of ["One ", "two ", "three ", "four."])
    socket.emit({ type: "reply.delta", seq: 2, thinkId: "t1", text: word });
  await waitFor(() => expect(reply?.text).toBe("One two three four."));
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
