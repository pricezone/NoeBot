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
 * The session with a piece of Clicky's reply appended, or `"refetch"` when the piece is for a
 * snapshot this tab never saw, or null when it is late and there is nothing to do.
 */
export function applyReplyDelta(
  held: ClickySession | undefined,
  delta: { seq: number; text: string },
): ClickySession | "refetch" | null {
  if (!held || delta.seq > held.seq) return "refetch";
  if (delta.seq < held.seq) return null;
  // A reply already marked whole has nothing more coming; a straggler must not add to it.
  if (held.reply?.final) return null;
  return {
    ...held,
    reply: {
      ...(held.reply ?? {}),
      text: `${held.reply?.text ?? ""}${delta.text}`,
      final: false,
    },
  };
}

/** The first retry waits a second, each one after twice as long, up to half a minute. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function openEvents(botId: string, client: QueryClient): () => void {
  const key = clickyKeys.session(botId);
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const refetch = () =>
    void client.invalidateQueries({ queryKey: key, exact: true });

  const onMessage = (message: ServerMessage) => {
    if (message.type === "resync") {
      refetch();
      return;
    }
    if (message.type === "snapshot") {
      client.setQueryData<ClickySession>(key, (held) =>
        newerSession(held, message.session),
      );
      return;
    }
    const next = applyReplyDelta(client.getQueryData(key), message);
    if (next === "refetch") refetch();
    else if (next) client.setQueryData(key, next);
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
      attempt = 0;
    };
    opened.onmessage = (event: MessageEvent) => {
      const message = parseMessage(event.data);
      if (message) onMessage(message);
    };
    opened.onclose = () => {
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

/**
 * This person's Clicky session on `botId`'s computer, live. Nothing is fetched or opened while
 * `enabled` is false (Clicky off on this deployment, a finished turn, no Bot).
 *
 * `surface` says what is drawing it, for the stop pill: a viewer draws its own Stop, so the pill
 * stays out of the way of one.
 */
export function useClickySession(
  botId: string | undefined,
  enabled: boolean,
  surface: "viewer" | "preview" | "watch" = "preview",
) {
  const active = enabled && Boolean(botId);
  const session = useQuery(
    { ...clickySessionQueryOptions(botId ?? ""), enabled: active },
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
  return session;
}
