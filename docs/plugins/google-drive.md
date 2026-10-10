# Google Drive

A Bot with this connector reads Drive **as the person asking**. Two people asking the same question
get the answers their own accounts can see, and neither sees anything they could not open
themselves. Read-only: the scope requested is `drive.readonly`, so Google refuses a write before
this deployment has to.

The connector reaches Drive over its ordinary REST API (`www.googleapis.com/drive/v3`), not Google's
hosted Drive MCP server. The MCP server is gated behind the Google Workspace Developer Preview
Program; the REST API underneath has been generally available since 2015, so this trades "no code" for
"no dependency on a preview", which for a connector people rely on is the better side of the trade.
The tool names match Google's MCP server exactly, so a later swap back to it would keep every grant.

## Connecting

Any signed-in person connects Google Drive themselves, from **Connect apps → Marketplace → Apps**.
**Connect** on the Google Drive row opens its page under `/settings/connected-accounts/google-drive`,
and **Connect** there leaves OpenBot for Google's own consent screen — the arrow on the button says
so — and returns to the same page, which then reads **Connected** with the scope Google actually
granted.

The first connection adds the app to the deployment and offers it to every Bot, existing and
future. There is no administrator step before it and no tool to grant after it; the tool list is
OpenBot's own code rather than an answer from a remote server, so it is recorded when the app is
added and needs no account to read. An administrator can narrow the offer on
`/admin/plugins/google-drive`: switch **Offered to every Bot** off, and the per-Bot grants on that
page decide instead. A member connecting again cannot switch it back on. The **Connect apps**
capability, on by default, is the switch that turns self-service off for a role or the whole
organization; with it off, Connect from the Marketplace is refused.

There is deliberately no endpoint for an administrator to connect an account on somebody's behalf.

Nothing is cached. OpenBot stores the refresh token and mints a short-lived access token for each
call, so revoking access at Google takes effect on the next call rather than whenever a cache
expires.

### Disconnecting

**Not built yet.** Until it is, revoke it in Google's own third-party access settings
([myaccount.google.com/connections](https://myaccount.google.com/connections)), which stops this
deployment reading anything immediately. The page says the same thing rather than offering a control
that would report access withdrawn when it had not been.

## The OAuth client

Google issues no token an administrator can paste: access is a grant belonging to a person, and the
deployment needs an OAuth client to ask for one. The client comes from one of two places, and the
first wins:

- **A platform-provided client.** A platform running many deployments registers one Google client
  and hands each deployment its id as `OPENBOT_PLUGIN_OAUTH_CLIENT_GOOGLE_DRIVE_ID`, together with
  `OPENBOT_PLUGIN_OAUTH_REDIRECT_URL` (the relay that client was registered to send people back
  through), `OPENBOT_PLUGIN_OAUTH_TOKEN_URL` (the platform's token endpoint, which holds the secret
  and redeems codes and renews tokens) and `OPENBOT_PLUGIN_OAUTH_TOKEN` (the bearer the platform
  admits the deployment on; `OPENBOT_USAGE_TOKEN` serves where that is unset). The deployment never
  holds the secret. Nothing is done on the Plugins page, which reports the client as provided by
  the platform. [Configuration](../configuration.md) describes the settings in full.
- **A client an administrator pastes**, for a self-hosted deployment with no platform behind it.
  Register one at Google as below and paste it under **OAuth client** on
  `/admin/plugins/google-drive`. Until a client exists from either place, Connect adds the app and
  then refuses, saying an administrator has to add one first.

### Self-hosted: registering a client

#### 1. Enable the Drive API

In a Google Cloud project, enable `drive.googleapis.com` — the Drive API. That is the only API this
connector calls; it reaches Drive over the REST API rather than a Workspace MCP server, so there is
no second API to turn on and no preview program to enrol in. A connector that returns `403` where the
credential is otherwise good is most often this API not being enabled on the project; see
[Troubleshooting](#troubleshooting).

#### 2. Configure the OAuth consent screen

- Scope: `https://www.googleapis.com/auth/drive.readonly`.
- While the app is in **Testing**, only accounts listed as test users can consent. Everyone who will
  connect needs to be on that list, or their consent fails with an access-denied error that says
  nothing about test users.

#### 3. Create an OAuth client

Type **Web application**. Under **Authorised redirect URIs**, add this deployment's callback:

```
<OPENBOT_PUBLIC_URL>/api/plugins/oauth/callback
```

Locally that is `http://localhost:3001/api/plugins/oauth/callback` — port 3001, the API, not 3010,
the app. The callback lands on the API and redirects back to the app afterwards.

It has to match character for character: scheme, host, port, path, no trailing slash. OpenBot shows
the exact string to paste under the **Connection** section of the plugin page, built from
`OPENBOT_PUBLIC_URL` rather than from the incoming request — a redirect URI assembled from a request
header is one an attacker has a say in. Copy it from there rather than typing it.

Keep the client ID and client secret for the next step.

#### 4. Paste it into OpenBot

At `/admin/plugins/google-drive`, open **OAuth client** and paste the client ID and secret. The
secret is encrypted with `KEY_ENCRYPTION_KEY` and never read back out to the browser. If nobody has
connected yet, **Enable for this deployment** on the same page adds the app first; an app added
there rather than from the Marketplace is not offered to every Bot until the switch below it says
so.

To check it actually works, use **Your account** on the same page: it connects *your* Google account
and returns you here. That is a personal grant like anybody else's, reaching your documents only, and
it is not part of configuring the connector.

## Troubleshooting

Every message below is what OpenBot actually shows. They are worth reading literally: the connector
distinguishes "the credential was refused" from "the credential was accepted and the request was
refused", and those have completely different fixes.

**Look at the audit trail first.** Every call leaves one row, written after the attempt, and the
event type is the answer to "whose problem is this":

| Row                  | Means                                                                  |
| -------------------- | ---------------------------------------------------------------------- |
| `mcp.call_rejected`  | This deployment declined. A missing grant, or a policy rule — `decision.rule` names which. |
| `mcp.call_failed`    | Permitted here, failed at the vendor. `failure` carries the vendor's own sentence. |
| `mcp.call_succeeded` | The vendor answered.                                                    |

A Bot that appears to have no access and leaves **no rows at all** never called the tool, which is a
grant problem rather than a connection problem. On `/admin/plugins/google-drive`, check that the app
is still **Offered to every Bot**, or, where an administrator switched that off, that the tool is
granted to *that* Bot. Connecting your account grants nothing by itself.

### `redirect_uri_mismatch` on the consent screen

Google is comparing the `redirect_uri` OpenBot sent against the list on the OAuth client, as exact
strings. Compare the value shown under **Connection** on the plugin page with what is registered,
character for character. Common mismatches: `127.0.0.1` against `localhost`, the app's port instead
of the API's, `https` against `http`, a trailing slash.

The client the error is about is the one whose ID is in the URL. A deployment with more than one
Google client can have the URI registered on the wrong one. With a platform-provided client the URI
Google sees is the platform's relay, `OPENBOT_PLUGIN_OAUTH_REDIRECT_URL`, and the registration is
the platform's to fix.

### "Google Drive refused this request (401)."

Google will not accept the token at all. Reconnecting the account at
`/settings/connected-accounts/google-drive` is the usual fix. If it persists, the scopes granted do
not cover this connector — check what the **Access** section reports as granted against the
`drive.readonly` scope this connector asks for.

### "Google Drive refused this request (403): …"

The credential is fine; Google accepted it and refused the request. Read the sentence after the colon
— it is Google's own, and for the most common cause it names the API and includes the console URL to
enable it. That cause is [step 1](#1-enable-the-drive-api): `drive.googleapis.com` is not enabled on
the project.

Enabling an API takes a few minutes to propagate. Wait, then try again.

If the sentence is about access to a specific file rather than an API, the account genuinely cannot
see what was asked for, which is the connector working as intended.

### "Google Drive could not be reached: …" or "Google Drive did not answer in time."

Not a credential problem: the request never got a verdict from Google. The first is a network or DNS
failure carrying its own reason; the second is a request that ran past the connector's timeout. Both
are worth retrying, and a persistent one is about the path between this deployment and Google rather
than about the account.

### "You have not connected your Google Drive account."

The Bot was asked to read as somebody with no connection stored. Connect at
`/settings/connected-accounts/google-drive`. There is no fallback to a deployment-wide credential —
by design, since a fallback would answer with somebody else's access.

### The connection worked and stopped about an hour later

That is an access token with no refresh token behind it, which OpenBot refuses to store precisely so
this cannot happen; if you see it, say so, because it means something got past that check. Google
returns no refresh token when it believes the person already consented, which is why the
authorization URL sends both `access_type=offline` and `prompt=consent`.

### "The tool returned no content. Nothing was found, so there is nothing here to answer from."

Not an error. The tool ran and matched nothing, and this sentence exists so a model is told that
rather than handed an empty string it would fill in from memory.

## See also

- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`,
  `KEY_ENCRYPTION_KEY`, and the `OPENBOT_PLUGIN_OAUTH_*` settings for a platform-provided client.
- [Google Drive API](https://developers.google.com/workspace/drive/api/reference/rest/v3) — the REST
  API this connector calls.
