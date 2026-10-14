import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ClickyServerEvent } from "../../../shared/clicky";
import type { AppVariables } from "../auth/guards";
import { upgradeWebSocket } from "../channels/socket";
import type { ClickyHub } from "./hub";
import { parseClickyCommand, parseClickyGuide } from "./schema";
import type { ClickyService } from "./service";

/**
 * Clicky's HTTP and WebSocket surface, under a Bot's computer: `/api/computers/:botId/clicky/...`.
 *
 * Mounted inside the computer router after its `/:botId/*` guard (`computer/routes.ts`), so every
 * route here is already signed in and scoped to a Bot whose computer this person may use. A session
 * is always the asking person's own with that Bot; there is no way to name anybody else's.
 *
 * - `GET /:botId/clicky`: the session, opened fresh when there is none to resume.
 * - `POST /:botId/clicky/commands`: one command. A command the state machine refuses is still a 200,
 *   with `rejected` naming the notice to show: refused is an answer, not an error.
 * - `POST /:botId/clicky/guide`: the Bot's walkthrough, pointed at the elements its refs name.
 * - `GET /:botId/clicky/events`: a socket of snapshots and the reply as it arrives. Clients send
 *   nothing on it; commands go over POST, where they get an answer.
 */
export function createClickyRoutes(deps: {
  service: ClickyService;
  hub: ClickyHub;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const limit = bodyLimit({ maxSize: 64 * 1024 });

  const unavailable = (error: unknown) => {
    console.error(
      JSON.stringify({
        type: "clicky-route-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { error: "Clicky is not available right now. Try again." };
  };

  routes.get("/:botId/clicky", async (context) => {
    try {
      return context.json({
        session: await deps.service.open(
          context.var.actor.id,
          context.req.param("botId"),
        ),
      });
    } catch (error) {
      return context.json(unavailable(error), 503);
    }
  });

  routes.post("/:botId/clicky/commands", limit, async (context) => {
    const parsed = parseClickyCommand(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      const outcome = await deps.service.dispatch(
        context.var.actor.id,
        context.req.param("botId"),
        { type: "command", command: parsed.value },
      );
      if (!outcome) return context.json(unavailable("no session"), 503);
      return context.json({
        session: outcome.session,
        ...(outcome.rejected ? { rejected: outcome.rejected } : {}),
      });
    } catch (error) {
      return context.json(unavailable(error), 503);
    }
  });

  routes.post("/:botId/clicky/guide", limit, async (context) => {
    const parsed = parseClickyGuide(
      await context.req.json().catch(() => undefined),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);
    try {
      const { session, rejected } = await deps.service.guide(
        context.var.actor.id,
        context.req.param("botId"),
        parsed.value,
      );
      // Refused (Clicky is in the middle of an action) is an answer, like a refused command.
      return context.json({ session, ...(rejected ? { rejected } : {}) });
    } catch (error) {
      return context.json(unavailable(error), 503);
    }
  });

  routes.get(
    "/:botId/clicky/events",
    upgradeWebSocket((context) => {
      // Fixed at the upgrade: the socket belongs to whoever signed in for it, and to this Bot.
      const userId = context.var.actor.id;
      const botId = context.req.param("botId") ?? "";
      let detach = () => {};
      let open = true;
      return {
        onOpen: (_event, ws) => {
          /*
           * Never the same snapshot twice and never an older one after a newer: the session opened
           * for this socket can also arrive through the hub (a fresh session is announced), in
           * either order.
           */
          let last: { id: string; seq: number } | undefined;
          const send = (event: ClickyServerEvent) => {
            if (event.type === "snapshot") {
              const { id, seq } = event.session;
              if (last && last.id === id && seq <= last.seq) return;
              last = { id, seq };
            }
            ws.send(JSON.stringify(event));
          };
          detach = deps.hub.subscribe(userId, botId, send);
          void deps.service
            .open(userId, botId)
            .then((session) => {
              if (open) send({ type: "snapshot", session });
            })
            .catch(() => {
              if (open) send({ type: "resync" });
            });
        },
        onClose: () => {
          open = false;
          detach();
        },
        onError: () => {
          open = false;
          detach();
        },
      };
    }),
  );

  return routes;
}
