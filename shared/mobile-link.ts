/**
 * Linking a phone to an instance: the contract between the HyperNoesis app and this server.
 *
 * The phone is signed in to HyperNoesis, which knows the person's instance and holds the instance's
 * sign-in handoff secret. It asks HyperNoesis for a one-minute, single-use token minted for the
 * audience `mobile`, and trades it here for a session of its own:
 *
 *   POST /api/auth/signin-handoff/mobile   { token, device: { name, platform } }
 *   → { cookie, deviceId, expiresAt, user }
 *
 * `cookie` is the exact `Cookie` header value the phone sends from then on. It carries the session
 * cookie AND Better Auth's `dont_remember` cookie: without the second one the server slides a session
 * to its full lifetime on first use, and the phone's session is meant to end after a day. When it
 * ends, the phone asks HyperNoesis for a new token, so the person never signs in on the phone twice.
 *
 * The phone sends the link request with no cookies, never posts to `/api/auth/*` afterwards (Better
 * Auth checks the Origin of cookie-bearing auth posts, which a native app has none of), and signs out
 * with `DELETE /api/mobile/devices/:id`. Web tokens (no audience) are refused here, and mobile tokens
 * are refused by the web handoff.
 */

export const MOBILE_LINK_PATH = "/api/auth/signin-handoff/mobile";
export const MOBILE_LINK_AUDIENCE = "mobile";
export const MOBILE_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const MOBILE_DEVICE_NAME_LIMIT = 80;

export type MobilePlatform = "ios" | "android";

export type MobileLinkRequest = {
  token: string;
  device: { name: string; platform: MobilePlatform };
};

export type MobileLinkResponse = {
  cookie: string;
  deviceId: string;
  expiresAt: string;
  user: { id: string; email: string; name: string | null };
};

/** A phone linked to this person's account, as Settings › Phones lists it. */
export type MobileDevice = {
  id: string;
  name: string;
  platform: MobilePlatform;
  createdAt: string;
  lastSeenAt: string;
  /** The computer this phone's Clicky is paired with, if any. */
  clickyBotId: string | null;
  pushEnabled: boolean;
  /** The device the request came from. */
  current: boolean;
};

/** `PUT /api/mobile/devices/:id`: pair Clicky with a computer, or attach a push registration. */
export type MobileDeviceUpdate = {
  clickyBotId?: string | null;
  pushDeviceId?: string | null;
};
