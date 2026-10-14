import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { socketUrl } from "@/lib/socket-url";
import { queryClient } from "@/query-client";
import type { ClickySession } from "../../../../shared/clicky";
import { clickyKeys, clickySessionQueryOptions, newerSession } from "./queries";
import { showClickySession } from "./shown-sessions";

/**
 * A Bot's Clicky session, kept current by the server's events socket.
 *
 * ONE SOCKET PER BOT, HOWEVER MANY THINGS DRAW IT. The viewer's overlay and bar, the panel's
 * preview, a live transcript tile and the stop pill can all show the same session at once; each asks
 * for it here, and the socket is opened by the first and closed by the last (`subscribeClickyEvents`
 * counts them). Everything they draw comes from the one query cache entry the socket writes into.
 *
 * THE NEWEST COPY WINS. The server sends a whole snapshot on open and on every change, a `reply.delta`
 * while Clicky's words are arriving, and `resync` when it may have dropped something. A snapshot with
 * a lower `seq` than the one held is late and ignored (`newerSession`); a delta for a later `seq` than
 * the one held means a snapshot was missed, and the session is fetched again rather than patched.
 * The socket reconnects with backoff and fetches the session again each time it does.
 *
 * WORDS ARRIVE CHEAPLY. Deltas are gathered and written once per animation frame, and each surface
 * reads only the slice it draws (`select`): while a reply streams, only the line that shows the reply
 * is drawn again, not the viewer around it.
 */

/** What the events socket may send. Anything else is ignored. */
type ServerMessage =
  | { type: "snapshot"; session: ClickySession }
  | { type: "reply.delta"; seq: number; text: string }
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
    "text" in value &&
    typeof value.text === "string"
  )
    return { type: "reply.delta", seq: value.seq, text: value.text };
  return null;
}

/**
 * The session with a piece of Clicky's reply added, or `"refetch"` when the piece is for a snapshot
 * this tab never saw, or null when it is late and there is nothing to do.
 *
 * The server stamps a delta with the `seq` of the thinking snapshot it belongs to, and that snapshot
 * still carries the PREVIOUS reply, whole ("Hi! Ask me anything…" after a wake, the Bot's request
 * after an activation): the reducer only replaces it when the answer is in. So the first piece of a
 * new answer starts a new reply of its own, and the pieces after it are appended to that one.
 */
export function applyReplyDelta(
  held: ClickySession | undefined,
  delta: { seq: number; text: string },
): ClickySession | "refetch" | null {
  if (!held || delta.seq > held.seq) return "refetch";
  if (delta.seq < held.seq) return null;
  const reply = held.reply;
  if (reply && !reply.final)
    return { ...held, reply: { ...reply, text: `${reply.text}${delta.text}` } };
  // A reply already whole, with Clicky not thinking: nothing more is coming, a straggler is dropped.
  if (held.state !== "thinking") return null;
  return { ...held, reply: { text: delta.text, final: false } };
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
  /** Pieces of a reply waiting for the next frame, in order. */
  let pending: { seq: number; text: string }[] = [];
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

  const flush = () => {
    flushing = false;
    if (closed) return;
    const pieces = pending;
    pending = [];
    let held = client.getQueryData<ClickySession>(key);
    let changed = false;
    for (const piece of pieces) {
      const next = applyReplyDelta(held, piece);
      if (next === "refetch") {
        refetch();
        return;
      }
      if (next) {
        held = next;
        changed = true;
      }
    }
    if (changed && held) client.setQueryData(key, held);
  };

  const onMessage = (message: ServerMessage) => {
    if (message.type === "resync") {
      refetch();
      return;
    }
    if (message.type === "snapshot") {
      // Pieces still waiting belong before this snapshot; apply them first so the order holds.
      if (pending.length) flush();
      client.setQueryData<ClickySession>(key, (held) =>
        newerSession(held, message.session),
      );
      return;
    }
    pending.push({ seq: message.seq, text: message.text });
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
    pending = [];
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

const whole = (session: ClickySession) => session;

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
      select: select ?? (whole as (session: ClickySession) => T),
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

/**
 * The session with a reply that is still arriving blanked out, so a surface that does not draw the
 * words is not drawn again for each one. Whether a reply is arriving is still there to read.
 */
export function selectClickyCalm(session: ClickySession): ClickySession {
  const reply = session.reply;
  if (!reply || reply.final) return session;
  return { ...session, reply: { text: "", final: false } };
}

/** The reply alone, for the one line that draws its words as they arrive. */
export function selectClickyReply(
  session: ClickySession,
): ClickySession["reply"] {
  return session.reply;
}
