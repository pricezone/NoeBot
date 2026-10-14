import { and, gt, inArray } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";
import { computerAccessCheck } from "../agents/computer-access";
import type { AgentProfileStore } from "../agents/profile-store";
import { type AuditStore, PERSON_INITIATOR, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { MobileLinkedInput } from "../auth/signin-handoff";
import { deploymentOrigins, sameSiteGuard } from "../computer/same-site-guard";
import type { DeploymentConfig } from "../config";
import {
  createSocketSessions,
  type SocketSessions,
} from "../clicky/socket-sessions";
import type { Database } from "../db/client";
import { sessions as authSessions } from "../db/schema";
import { createMobileRoutes } from "./routes";
import {
  createMobileDeviceStore,
  type MobileDeviceStore,
  sessionCookieName,
  sessionTokenFromCookies,
} from "./store";

/**
 * A person's linked phones, on every deployment with a database and a sign-in.
 *
 * The HyperNoesis app is Noë Bot's phone app as a whole (conversations, approvals, routines, memory),
 * not only its Clicky. So linking a phone, listing and signing out phones, and the push registration
 * a phone attaches never depend on Clicky being switched on or on a computer existing; Clicky only
 * adds the pairing of a phone with a computer and the "Noë Bot needs you" notification.
 */
export type MobileWiring = {
  store: MobileDeviceStore;
  /** Records a phone that has just been given a session; answers its id. */
  onMobileLinked(input: MobileLinkedInput): Promise<{ deviceId: string }>;
  /** `/api/mobile`, behind the session guard and the same-site guard. */
  routes(
    requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  ): Hono<{ Variables: AppVariables }>;
  /**
   * Hear a phone being signed out, with the session token it held, so whatever that phone still has
   * open (a Clicky socket) can be closed at once. Returns the unsubscribe.
   */
  onRevoked(listener: (sessionToken: string) => void): () => void;
  /** This deployment's session token in a Cookie header, or null. */
  sessionTokenOf(cookie: string | undefined | null): string | null;
  /**
   * Every long-lived socket a person holds (Clicky's events, the live screen), kept with the session
   * it opened on: closed when that phone is signed out, and swept for ended sessions.
   */
  sockets: SocketSessions;
  start(): void;
  stop(): void;
};

export function createMobileWiring(deps: {
  database: Database;
  auditStore?: AuditStore;
  agentProfileStore: Pick<AgentProfileStore, "get">;
  config: Pick<DeploymentConfig, "auth" | "publicUrl" | "appUrl">;
  store?: MobileDeviceStore;
}): MobileWiring {
  const store = deps.store ?? createMobileDeviceStore(deps.database);
  const cookieName = sessionCookieName(deps.config.auth?.baseUrl);
  const sockets = createSocketSessions({
    alive: async (tokens) =>
      new Set(
        (
          await deps.database
            .select({ token: authSessions.token })
            .from(authSessions)
            .where(
              and(
                inArray(authSessions.token, tokens),
                gt(authSessions.expiresAt, new Date()),
              ),
            )
        ).map((row) => row.token),
      ),
  });
  const listeners = new Set<(sessionToken: string) => void>([
    (sessionToken) => sockets.revoke(sessionToken),
  ]);
  const tell = (sessionToken: string) => {
    for (const listener of listeners) {
      try {
        listener(sessionToken);
      } catch {
        // One listener failing must not keep the others from closing what the phone held.
      }
    }
  };
  return {
    store,
    async onMobileLinked(input) {
      const { deviceId, reused, endedSessionToken } = await store.link(input);
      if (endedSessionToken) tell(endedSessionToken);
      if (deps.auditStore)
        await recordAuditEvent(deps.auditStore, {
          eventType: "mobile.device_linked",
          targetType: "person",
          targetId: input.userId,
          actorUserId: input.userId,
          initiator: PERSON_INITIATOR,
          payload: {
            deviceId,
            platform: input.device.platform,
            // The same phone linking again (it named its own row) or a phone new to this person.
            linkedAgain: reused,
          },
        }).catch(() => undefined);
      return { deviceId };
    },
    routes(requireUser) {
      return createMobileRoutes({
        store,
        requireUser,
        sameSite: sameSiteGuard(deploymentOrigins(deps.config)),
        canUseComputer: computerAccessCheck(deps.agentProfileStore),
        ...(deps.auditStore ? { auditStore: deps.auditStore } : {}),
        onRevoked: tell,
        sessionCookie: cookieName,
      });
    },
    onRevoked(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessionTokenOf(cookie) {
      return sessionTokenFromCookies(cookie, cookieName);
    },
    sockets,
    start() {
      sockets.start();
    },
    stop() {
      sockets.stop();
    },
  };
}
