import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import {
  MOBILE_DEVICE_NAME_LIMIT,
  type MobileDevice,
  type MobilePlatform,
} from "../../../shared/mobile-link";
import type { MobileLinkedInput } from "../auth/signin-handoff";
import type { Database } from "../db/client";
import { mobileDevices, pushDevices, sessions } from "../db/schema";

/**
 * A person's linked phones (`mobile_devices`).
 *
 * A phone is linked through the HyperNoesis app and holds one Better Auth session, which ends after a
 * day; the app then links again. So a row is the phone, not the session: linking again with the same
 * name and platform takes over the row whose session has ended, and keeps what the person set on it
 * (the computer its Clicky is paired with, its push registration). Revoking deletes the session, so
 * the phone is signed out at once, and marks the row so it is not taken over again.
 */

export type MobileDeviceRow = {
  id: string;
  userId: string;
  name: string;
  platform: MobilePlatform;
  sessionId: string | null;
  pushDeviceId: string | null;
  clickyBotId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  pushEnabled: boolean;
};

export type MobileDeviceStore = {
  /** Records a phone that has just been given a session; answers its id. */
  link(
    input: MobileLinkedInput,
  ): Promise<{ deviceId: string; reused: boolean }>;
  /** The person's phones that have not been revoked, most recently seen first. */
  list(userId: string): Promise<MobileDeviceRow[]>;
  get(userId: string, id: string): Promise<MobileDeviceRow | null>;
  update(
    userId: string,
    id: string,
    patch: { clickyBotId?: string | null; pushDeviceId?: string | null },
  ): Promise<MobileDeviceRow | null>;
  /** Signs the phone out (its session is deleted) and marks it revoked. Null when there is none. */
  revoke(
    userId: string,
    id: string,
  ): Promise<{ sessionId: string | null } | null>;
  /** The phone a request came from, by the session token in its cookie. */
  deviceForToken(
    userId: string,
    token: string,
  ): Promise<MobileDeviceRow | null>;
  touch(id: string): Promise<void>;
  /** Whether a push registration is the person's own and still on. */
  ownsPushDevice(userId: string, pushDeviceId: string): Promise<boolean>;
  /** Where "Noë Bot needs you" goes for this Bot: the phones paired with it, or with none. */
  pushTokens(userId: string, botId: string): Promise<string[]>;
};

export function toMobileDevice(
  row: MobileDeviceRow,
  currentId: string | null,
): MobileDevice {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    clickyBotId: row.clickyBotId,
    pushEnabled: row.pushEnabled,
    current: row.id === currentId,
  };
}

export function createMobileDeviceStore(database: Database): MobileDeviceStore {
  const columns = {
    id: mobileDevices.id,
    userId: mobileDevices.userId,
    name: mobileDevices.name,
    platform: mobileDevices.platform,
    sessionId: mobileDevices.sessionId,
    pushDeviceId: mobileDevices.pushDeviceId,
    clickyBotId: mobileDevices.clickyBotId,
    createdAt: mobileDevices.createdAt,
    lastSeenAt: mobileDevices.lastSeenAt,
    pushEnabled: pushDevices.enabled,
  };
  const select = () =>
    database
      .select(columns)
      .from(mobileDevices)
      .leftJoin(pushDevices, eq(pushDevices.id, mobileDevices.pushDeviceId));
  const row = (
    value: Omit<MobileDeviceRow, "pushEnabled"> & {
      pushEnabled: boolean | null;
    },
  ): MobileDeviceRow => ({
    ...value,
    pushEnabled: Boolean(value.pushDeviceId && value.pushEnabled),
  });

  const store: MobileDeviceStore = {
    async link({ userId, sessionId, device }) {
      const name = device.name.trim().slice(0, MOBILE_DEVICE_NAME_LIMIT);
      // The same phone linking again after its day: the row whose session is gone or over.
      const candidates = await database
        .select({
          id: mobileDevices.id,
          sessionId: mobileDevices.sessionId,
          expiresAt: sessions.expiresAt,
        })
        .from(mobileDevices)
        .leftJoin(sessions, eq(sessions.id, mobileDevices.sessionId))
        .where(
          and(
            eq(mobileDevices.userId, userId),
            eq(mobileDevices.name, name),
            eq(mobileDevices.platform, device.platform),
            isNull(mobileDevices.revokedAt),
          ),
        )
        .orderBy(desc(mobileDevices.lastSeenAt));
      const ended = candidates.find(
        (candidate) =>
          !candidate.sessionId ||
          !candidate.expiresAt ||
          candidate.expiresAt.getTime() <= Date.now(),
      );
      if (ended) {
        await database
          .update(mobileDevices)
          .set({ sessionId, lastSeenAt: new Date() })
          .where(eq(mobileDevices.id, ended.id));
        return { deviceId: ended.id, reused: true };
      }
      const id = randomUUID();
      await database.insert(mobileDevices).values({
        id,
        userId,
        name,
        platform: device.platform,
        sessionId,
      });
      return { deviceId: id, reused: false };
    },

    async list(userId) {
      return (
        await select()
          .where(
            and(
              eq(mobileDevices.userId, userId),
              isNull(mobileDevices.revokedAt),
            ),
          )
          .orderBy(desc(mobileDevices.lastSeenAt))
      ).map(row);
    },

    async get(userId, id) {
      const [found] = await select().where(
        and(
          eq(mobileDevices.id, id),
          eq(mobileDevices.userId, userId),
          isNull(mobileDevices.revokedAt),
        ),
      );
      return found ? row(found) : null;
    },

    async update(userId, id, patch) {
      const set = {
        ...(patch.clickyBotId !== undefined
          ? { clickyBotId: patch.clickyBotId }
          : {}),
        ...(patch.pushDeviceId !== undefined
          ? { pushDeviceId: patch.pushDeviceId }
          : {}),
      };
      if (Object.keys(set).length > 0)
        await database
          .update(mobileDevices)
          .set(set)
          .where(
            and(
              eq(mobileDevices.id, id),
              eq(mobileDevices.userId, userId),
              isNull(mobileDevices.revokedAt),
            ),
          );
      return store.get(userId, id);
    },

    async revoke(userId, id) {
      return database.transaction(async (tx) => {
        const [found] = await tx
          .update(mobileDevices)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(mobileDevices.id, id),
              eq(mobileDevices.userId, userId),
              isNull(mobileDevices.revokedAt),
            ),
          )
          .returning({ sessionId: mobileDevices.sessionId });
        if (!found) return null;
        if (found.sessionId)
          await tx
            .delete(sessions)
            .where(
              and(
                eq(sessions.id, found.sessionId),
                eq(sessions.userId, userId),
              ),
            );
        return { sessionId: found.sessionId };
      });
    },

    async deviceForToken(userId, token) {
      const [found] = await select()
        .innerJoin(sessions, eq(sessions.id, mobileDevices.sessionId))
        .where(
          and(
            eq(sessions.token, token),
            eq(sessions.userId, userId),
            eq(mobileDevices.userId, userId),
            isNull(mobileDevices.revokedAt),
          ),
        );
      return found ? row(found) : null;
    },

    async touch(id) {
      await database
        .update(mobileDevices)
        .set({ lastSeenAt: new Date() })
        .where(eq(mobileDevices.id, id));
    },

    async ownsPushDevice(userId, pushDeviceId) {
      const [found] = await database
        .select({ id: pushDevices.id })
        .from(pushDevices)
        .where(
          and(
            eq(pushDevices.id, pushDeviceId),
            eq(pushDevices.ownerUserId, userId),
            eq(pushDevices.enabled, true),
          ),
        );
      return Boolean(found);
    },

    async pushTokens(userId, botId) {
      const rows = await database
        .selectDistinct({ token: pushDevices.token })
        .from(mobileDevices)
        .innerJoin(pushDevices, eq(pushDevices.id, mobileDevices.pushDeviceId))
        .where(
          and(
            eq(mobileDevices.userId, userId),
            isNull(mobileDevices.revokedAt),
            eq(pushDevices.ownerUserId, userId),
            eq(pushDevices.enabled, true),
            or(
              eq(mobileDevices.clickyBotId, botId),
              isNull(mobileDevices.clickyBotId),
            ),
          ),
        );
      return rows.map((found) => found.token);
    },
  };
  return store;
}

/**
 * The session token in a request's cookies: Better Auth's `session_token` cookie under whatever
 * prefix this deployment uses (`__Host-` on https here), its signature taken off. Not verified here:
 * the request has already been signed in with it, and it is only used to find which of the person's
 * own phones is asking.
 */
export function sessionTokenFromCookies(
  header: string | undefined,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name.endsWith("better-auth.session_token")) continue;
    let value = part.slice(separator + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    const dot = value.lastIndexOf(".");
    return (dot > 0 ? value.slice(0, dot) : value) || null;
  }
  return null;
}
