import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AgentActor } from "../agents/profile-types";
import { type AuditStore, PERSON_INITIATOR, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import {
  type MobileDeviceStore,
  sessionCookieName,
  sessionTokenFromCookies,
  toMobileDevice,
} from "./store";

/**
 * `/api/mobile`: a person's linked phones, for Settings › Phones and for the HyperNoesis app.
 *
 * Every route is the signed-in person's own phones and nothing else. The phone making the request is
 * the `current` one (found by the session in its cookie) and is marked seen. A phone pairs its
 * Clicky with one of the person's Bot computers, which must be one they may use, and attaches the
 * push registration it made (`/api/delivery/devices`), which must be theirs. Deleting a phone signs it
 * out at once.
 */
export function createMobileRoutes(deps: {
  store: MobileDeviceStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /** Whether this person may use this Bot's computer, as the computer routes ask it. */
  canUseComputer: (actor: AgentActor, botId: string) => Promise<boolean>;
  auditStore?: AuditStore;
  /** Refuses requests a page on another site made with the person's cookies (same-site-guard.ts). */
  sameSite?: MiddlewareHandler;
  /** Told the session token of a phone just signed out, so its open sockets close. */
  onRevoked?: (sessionToken: string) => void;
  /** This deployment's session cookie name (see `sessionCookieName`). */
  sessionCookie?: string;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  if (deps.sameSite) routes.use("*", deps.sameSite);
  routes.use("*", deps.requireUser, bodyLimit({ maxSize: 16 * 1024 }));

  /** The phone this request came from, marked seen; null for a browser. */
  const currentDevice = async (userId: string, cookie: string | undefined) => {
    const token = sessionTokenFromCookies(
      cookie,
      deps.sessionCookie ?? sessionCookieName(undefined),
    );
    if (!token) return null;
    const device = await deps.store.deviceForToken(userId, token);
    if (device) await deps.store.touch(device.id);
    return device;
  };

  routes.get("/devices", async (context) => {
    const actor = context.var.actor;
    const current = await currentDevice(actor.id, context.req.header("cookie"));
    const devices = await deps.store.list(actor.id);
    return context.json({
      devices: devices.map((device) =>
        toMobileDevice(device, current?.id ?? null),
      ),
    });
  });

  const update = z.strictObject({
    clickyBotId: z.string().trim().min(1).max(200).nullable().optional(),
    pushDeviceId: z.string().trim().min(1).max(200).nullable().optional(),
  });

  routes.put("/devices/:id", async (context) => {
    const actor = context.var.actor;
    const parsed = update.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json({ error: "Supply a valid request." }, 400);
    const current = await currentDevice(actor.id, context.req.header("cookie"));
    const id = context.req.param("id");
    const device = await deps.store.get(actor.id, id);
    if (!device) return context.json({ error: "There is no such phone." }, 404);
    const { clickyBotId, pushDeviceId } = parsed.data;
    if (
      clickyBotId &&
      !(await deps.canUseComputer(
        { id: actor.id, role: actor.role },
        clickyBotId,
      ))
    )
      return context.json(
        { error: "Choose a Bot whose computer you can use." },
        400,
      );
    if (
      pushDeviceId &&
      !(await deps.store.ownsPushDevice(actor.id, pushDeviceId))
    )
      return context.json(
        { error: "Choose a push registration of your own." },
        400,
      );
    const updated = await deps.store.update(actor.id, id, {
      ...(clickyBotId !== undefined ? { clickyBotId } : {}),
      ...(pushDeviceId !== undefined ? { pushDeviceId } : {}),
    });
    if (!updated)
      return context.json({ error: "There is no such phone." }, 404);
    return context.json({
      device: toMobileDevice(updated, current?.id ?? null),
    });
  });

  routes.delete("/devices/:id", async (context) => {
    const actor = context.var.actor;
    const id = context.req.param("id");
    const current = await currentDevice(actor.id, context.req.header("cookie"));
    const revoked = await deps.store.revoke(actor.id, id);
    if (!revoked)
      return context.json({ error: "There is no such phone." }, 404);
    if (revoked.sessionToken) deps.onRevoked?.(revoked.sessionToken);
    if (deps.auditStore)
      await recordAuditEvent(deps.auditStore, {
        eventType: "mobile.device_revoked",
        targetType: "person",
        targetId: actor.id,
        actorUserId: actor.id,
        initiator: PERSON_INITIATOR,
        payload: {
          deviceId: id,
          // Signing a phone out from that same phone, or from somewhere else.
          from: current?.id === id ? "this phone" : "another device",
        },
      }).catch(() => undefined);
    return context.body(null, 204);
  });

  return routes;
}
