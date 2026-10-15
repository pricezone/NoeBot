import { hashKey, type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { socketUrl } from "@/lib/socket-url";
import { queryClient } from "@/query-client";
import type { ClickySession } from "../../../../shared/clicky";
import { clickyKeys, clickySessionQueryOptions, newerSession } from "./queries";
import { showClickySession } from "./shown-sessions";

/**
 * A Bot's Clicky session, kept current by the server's events socket.
 *
 * ONE SOCKET PER BOT, HOWEVER MANY THINGS DRAW IT. The viewer's overlay, its instruction and its
 * bar, a live transcript tile and the stop pill can all show the same session at once; each asks
 * for it here, and the socket is opened by the first and closed by the last (`subscribeClickyEvents`
 * counts them). Everything they draw comes from the one query cache entry the socket writes into.
 *
 * THE NEWEST COPY WINS. The server sends a whole snapshot on open and on every change, a `reply.delta`
 * while Clicky's words are arriving, and `resync` when it may have dropped something. A snapshot with
 * a lower `seq` than the one held is late and ignored (`newerSession`). The socket reconnects with
 * backoff and fetches the session again each time it does.
 *
 * WORDS ARRIVING ARE KEPT APART FROM THE SESSION. The cache holds only what the server sent as a
 * snapshot. The words of an answer still arriving are collected here, per Bot, keyed by the session
 * and the model call they belong to (`thinkId`), never by `seq`: the session keeps the previous,
 * whole reply until the answer is in, `seq` moves while one call is still answering (Clicky's first
 * pointer on activation is a snapshot of its own), and a session started afresh counts from zero
 * again. They are shown while that session is thinking on that call (`shownReply`), written once per
 * animation frame, and read only by the line that draws them: nothing else is drawn again per word.
 */

/** What the events socket may send. Anything else is ignored. */
type ServerMessage =
  | { type: "snapshot"; session: ClickySession }
  | { type: "reply.delta"; seq: number; thinkId: string; text: string }
  | { type: "resync" };

function parseMessage(data: unknown): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(String(data));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("type" in value))
    return null;
  if (value.type === "resync") return { type: "resync" };
  if (
    value.type === "snapshot" &&
    "session" in value &&
    typeof value.session === "object" &&
    value.session !== null &&
    "seq" in value.session &&
    typeof value.session.seq === "number"
  )
    return { type: "snapshot", session: value.session as ClickySession };
  if (
    value.type === "reply.delta" &&
    "seq" in value &&
    typeof value.seq === "number" &&
    "thinkId" in value &&
    typeof value.thinkId === "string" &&
    "text" in value &&
    typeof value.text === "string"
  )
    return {
      type: "reply.delta",
      seq: value.seq,
      thinkId: value.thinkId,
      text: value.text,
    };
  return null;
}

/** The words of one answer still arriving: which session, which model call, and the words so far. */
export type ClickyStream = { sessionId: string; thinkId: string; text: string };

/**
 * The stream after a piece of an answer arrives, and whether the session should be fetched again.
 *
 * A piece counts when this tab's session is waiting on its model call, or when it is for a snapshot
 * this tab has not seen yet (a later `seq`; that snapshot is fetched). A piece of another call, or
 * one with no session to put it in, is dropped. The first piece of a call starts its stream; the
 * rest are appended.
 */
export function acceptReplyDelta(
  held: ClickySession | undefined,
  stream: ClickyStream | null,
  delta: { seq: number; thinkId: string; text: string },
): { stream: ClickyStream | null; refetch: boolean } {
  if (!held) return { stream, refetch: true };
  const ahead = delta.seq > held.seq;
  if (held.thinkId !== delta.thinkId && !ahead)
    return { stream, refetch: false };
  const same =
    stream !== null &&
    stream.sessionId === held.id &&
    stream.thinkId === delta.thinkId;
  return {
    stream: same
      ? { ...stream, text: `${stream.text}${delta.text}` }
      : { sessionId: held.id, thinkId: delta.thinkId, text: delta.text },
    refetch: ahead,
  };
}

/**
 * The stream after a snapshot is kept: gone once the session is another one, waits on another call,
 * or has stopped thinking. A newer `seq` of the same call, still thinking, keeps the words so far.
 */
export function streamAfterSnapshot(
  stream: ClickyStream | null,
  session: ClickySession,
): ClickyStream | null {
  if (!stream) return null;
  if (
    stream.sessionId !== session.id ||
    stream.thinkId !== session.thinkId ||
    session.state !== "thinking"
  )
    return null;
  return stream;
}

/**
 * The reply to show: the words arriving, while the session is thinking on the call they belong to,
 * and otherwise the session's own reply (which, while thinking, is still the previous one).
 */
export function shownReply(
  session: Pick<ClickySession, "id" | "thinkId" | "state" | "reply">,
  stream: ClickyStream | null,
): ClickySession["reply"] {
  if (
    session.state === "thinking" &&
    stream !== null &&
    stream.text !== "" &&
    stream.sessionId === session.id &&
    stream.thinkId === session.thinkId
  )
    return { text: stream.text, final: false };
  return session.reply;
}

const streams = new Map<string, ClickyStream>();
const streamListeners = new Map<string, Set<() => void>>();

function writeStream(botId: string, next: ClickyStream | null) {
  const current = streams.get(botId) ?? null;
  if (current === next) return;
  if (next) streams.set(botId, next);
  else streams.delete(botId);
  for (const listener of streamListeners.get(botId) ?? []) listener();
}

/** The words of the answer arriving for this Bot, or null. */
export function useClickyStream(botId: string): ClickyStream | null {
  return useSyncExternalStore(
    (listener) => {
      const set = streamListeners.get(botId) ?? new Set();
      set.add(listener);
      streamListeners.set(botId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) streamListeners.delete(botId);
      };
    },
    () => streams.get(botId) ?? null,
    () => null,
  );
}

/** The first retry waits a second, each one after twice as long, up to half a minute. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * How long a socket has to stay open before it counts as working again. One that opens and drops at
 * once (a proxy that accepts and closes) keeps backing off instead of reconnecting every second.
 */
const STABLE_AFTER_MS = 5_000;

/** Once per frame where there are frames; a hidden tab has none, so a short timer there. */
function nextFrame(run: () => void): void {
  if (
    typeof requestAnimationFrame === "function" &&
    typeof document !== "undefined" &&
    document.visibilityState === "visible"
  )
    requestAnimationFrame(() => run());
  else setTimeout(run, 16);
}

function openEvents(botId: string, client: QueryClient): () => void {
  const key = clickyKeys.session(botId);
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stable: ReturnType<typeof setTimeout> | undefined;
  /** Pieces of an answer waiting for the next frame, in order. */
  let pending: { seq: number; thinkId: string; text: string }[] = [];
  let flushing = false;

  /*
   * One fetch at a time: a refetch already on its way answers a second reason to ask as well, so a
   * burst of resyncs or a reconnect during a fetch does not cancel and restart it.
   */
  const refetch = () =>
    void client.invalidateQueries(
      { queryKey: key, exact: true },
      { cancelRefetch: false },
    );

  /*
   * Whenever the cache takes a new session, by snapshot or by fetch, the words collected so far are
   * kept only if they still belong to it. Only a session that changed counts: marking the old one
   * stale (the refetch a piece ahead of its snapshot asks for) must not clear the words it brought.
   */
  const hashOfKey = hashKey(key);
  let seen = client.getQueryData<ClickySession>(key);
  const unwatch = client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryHash !== hashOfKey) return;
    const session = event.query.state.data as ClickySession | undefined;
    if (!session || session === seen) return;
    seen = session;
    writeStream(
      botId,
      streamAfterSnapshot(streams.get(botId) ?? null, session),
    );
  });

  const flush = () => {
    flushing = false;
    if (closed) return;
    const pieces = pending;
    pending = [];
    let stream = streams.get(botId) ?? null;
    let ask = false;
    for (const piece of pieces) {
      const next = acceptReplyDelta(
        client.getQueryData<ClickySession>(key),
        stream,
        piece,
      );
      stream = next.stream;
      ask ||= next.refetch;
    }
    writeStream(botId, stream);
    if (ask) refetch();
  };

  const onMessage = (message: ServerMessage) => {
    if (message.type === "resync") {
      refetch();
      return;
    }
    if (message.type === "snapshot") {
      // Pieces still waiting arrived before this snapshot; take them first so the order holds.
      if (pending.length) flush();
      client.setQueryData<ClickySession>(key, (held) =>
        newerSession(held, message.session),
      );
      return;
    }
    pending.push({
      seq: message.seq,
      thinkId: message.thinkId,
      text: message.text,
    });
    if (flushing) return;
    flushing = true;
    nextFrame(flush);
  };

  const connect = () => {
    if (closed) return;
    let opened: WebSocket;
    try {
      opened = new WebSocket(
        socketUrl(`/api/computers/${encodeURIComponent(botId)}/clicky/events`),
      );
    } catch {
      schedule();
      return;
    }
    socket = opened;
    opened.onopen = () => {
      // A reconnect may have missed changes; the server's own snapshot follows, but ask anyway.
      if (attempt > 0) refetch();
      clearTimeout(stable);
      stable = setTimeout(() => {
        if (socket === opened) attempt = 0;
      }, STABLE_AFTER_MS);
    };
    opened.onmessage = (event: MessageEvent) => {
      const message = parseMessage(event.data);
      if (message) onMessage(message);
    };
    opened.onclose = () => {
      clearTimeout(stable);
      if (socket === opened) socket = null;
      if (!closed) schedule();
    };
    // `onclose` follows an error and is where reconnecting happens.
    opened.onerror = () => {};
  };

  const schedule = () => {
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
    attempt += 1;
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
  };

  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(stable);
    unwatch();
    pending = [];
    writeStream(botId, null);
    const open = socket;
    socket = null;
    if (open) {
      open.onclose = null;
      open.onmessage = null;
      open.close();
    }
  };
}

const connections = new Map<string, { users: number; stop: () => void }>();

/** Starts listening to a Bot's Clicky events; the returned function stops this caller listening. */
export function subscribeClickyEvents(
  botId: string,
  client: QueryClient = queryClient,
): () => void {
  const existing = connections.get(botId);
  if (existing) existing.users += 1;
  else connections.set(botId, { users: 1, stop: openEvents(botId, client) });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const connection = connections.get(botId);
    if (!connection) return;
    connection.users -= 1;
    if (connection.users > 0) return;
    connections.delete(botId);
    connection.stop();
  };
}

/** The whole session, as a `select` that never changes. */
export function selectClickySession(session: ClickySession): ClickySession {
  return session;
}

/**
 * This person's Clicky session on `botId`'s computer, live, or the slice of it `select` picks.
 * Nothing is fetched or opened while `enabled` is false (Clicky off on this deployment, a finished
 * turn, no Bot).
 *
 * `select` should be a function defined once, outside the component: the slice is compared with the
 * last one, and the caller is drawn again only when it changed.
 *
 * `surface` says what is drawing it, for the stop pill: a viewer draws its own Stop, so the pill
 * stays out of the way of one.
 */
export function useClickySession<T = ClickySession>(
  botId: string | undefined,
  enabled: boolean,
  surface: "viewer" | "preview" | "watch" = "preview",
  select?: (session: ClickySession) => T,
): T | undefined {
  const active = enabled && Boolean(botId);
  const { data } = useQuery(
    {
      ...clickySessionQueryOptions(botId ?? ""),
      enabled: active,
      select: select ?? (selectClickySession as (session: ClickySession) => T),
    },
    queryClient,
  );
  useEffect(() => {
    if (!active || !botId) return;
    const stop = subscribeClickyEvents(botId);
    const hide = surface === "watch" ? null : showClickySession(botId, surface);
    return () => {
      stop();
      hide?.();
    };
  }, [active, botId, surface]);
  return data;
}

/**
 * A slice of a Bot's session as the cache holds it, for a part of a surface that already subscribed
 * (`useClickySession`): it never fetches and never opens a socket of its own.
 */
export function useClickySessionView<T>(
  botId: string,
  select: (session: ClickySession) => T,
): T | undefined {
  return useQuery(
    { ...clickySessionQueryOptions(botId), enabled: false, select },
    queryClient,
  ).data;
}

/** Where Clicky is, and whether it is awake: what the screen around it needs, and nothing more. */
export function selectClickyPresence(session: ClickySession): {
  awake: boolean;
  state: ClickySession["state"];
} {
  return { awake: session.awake, state: session.state };
}

/** What deciding which reply to show needs from the session. */
function selectReplyContext(
  session: ClickySession,
): Pick<ClickySession, "id" | "thinkId" | "state" | "reply"> {
  return {
    id: session.id,
    thinkId: session.thinkId,
    state: session.state,
    reply: session.reply,
  };
}

/**
 * The reply as the person should read it now: the words of the answer arriving, or the session's
 * own. For the one line that draws them; it is drawn again for each frame of words.
 */
export function useClickyReply(
  botId: string,
): ClickySession["reply"] | undefined {
  const context = useClickySessionView(botId, selectReplyContext);
  const stream = useClickyStream(botId);
  return context ? shownReply(context, stream) : undefined;
}
