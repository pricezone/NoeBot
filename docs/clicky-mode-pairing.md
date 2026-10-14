# Clicky Mode — linking a phone

Noë Bot's phone app is the HyperNoesis app. A person signed in there links it to their own Noë Bot
without typing anything, and then pairs Clicky with one of their Bots' computers.

## Why not the local network

Bluey finds the Mac over Bonjour, because the computer it controls is on the same Wi-Fi. Noë Bot's
computer is in the cloud, inside the person's own instance, so there is nothing on the local network
to find, and a listener there would only be one more thing to secure. The phone talks to the
instance's public HTTPS address, as the browser does. "Discovering a computer" means listing the Bots
the person can use and choosing one.

## The link

```
 phone (HyperNoesis app, signed in)                HyperNoesis API                 the instance
   │ POST /api/noebot/mobile/link  ───────────────►│ mints a 60 s, single-use token
   │◄──────────── { instanceUrl, token, expiresAt } │ (aud "mobile", HMAC with the instance's
   │                                                │  sign-in handoff secret)
   │ POST {instanceUrl}/api/auth/signin-handoff/mobile  { token, device }  (no cookies) ─────────►│
   │◄─────────────────────────────── { cookie, deviceId, expiresAt, user }  24 h session, phone row │
   │ every later call: Cookie: <cookie>                                                            │
```

- The token is refused if it is forged, expired, used before, minted for another instance, for
  another person, or for the web audience. Web tokens are refused here, mobile tokens on the web
  route.
- The session is opened with Better Auth's "don't remember me" flag, so it ends after 24 hours and
  does not slide; `cookie` carries both the session cookie and the `dont_remember` cookie, and the
  phone sends it back verbatim.
- When the instance answers 401, the phone asks HyperNoesis for a new token and links again, once.
  A 404 from the link route means the instance predates phones: the app asks the person to update
  Noë Bot from HyperNoesis.
- The phone never posts to `/api/auth/*` after linking (Better Auth checks the Origin of a cookie
  carrying auth post, and a native app has none). Signing out is
  `DELETE /api/mobile/devices/:id`, which deletes the session.

## Pairing Clicky with a computer

The Clicky screen lists the person's Bots. Choosing one is saved on the phone and on the server
(`PUT /api/mobile/devices/:id { clickyBotId }`), which is where "Noë Bot needs you" notifications for
that computer are sent. Switching is one tap; nothing on the computer changes.

## Notifications

With the person's permission the app registers its Expo push token with the instance
(`POST /api/delivery/devices`, which requires the HyperNoesis app's `EXPO_PROJECT_ID`) and attaches it
to the phone's row. Links in notifications start with `OPENBOT_MOBILE_LINK_BASE`
(`hypernoesis://noebot/` on hosted instances): `clicky?bot=…`, `approvals`, `conversation?id=…`.

## Session and reconnection

The Clicky screen keeps one WebSocket to `/api/computers/:botId/clicky/events` with the Cookie
header. Every change arrives as a snapshot with a `seq`; a gap or a reconnect refetches the snapshot,
so a phone that slept, lost signal or switched networks shows the same state as the web viewer
within a second of coming back. Commands (talk, approve, stop) go over HTTPS and answer with the new
session.

## Revoking

**Settings › Phones** in the web app lists every linked phone with its platform, when it was linked
and last seen, and which computer its Clicky is paired with. Revoke deletes its session at once; the
phone's next call answers 401, and its re-link needs the person's HyperNoesis account.
