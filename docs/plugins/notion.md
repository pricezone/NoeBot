# Notion

A Bot with this connector reaches Notion **as the person asking**, through the hosted MCP server
Notion runs at `mcp.notion.com`, on the catalogue's default MCP transport. Two people asking the
same question get the pages their own accounts can see, and neither sees anything they could not
open themselves. Unlike Google Drive, this connector ships both read and write tools: the writing
tools are named in the catalogue, and the action policy governs every call the same as any other
plugin tool.

## Connecting

Any signed-in person connects Notion themselves, from **Connect apps → Marketplace → Apps**.
**Connect** on the Notion row opens its page under `/settings/connected-accounts/notion`, and
**Connect** there leaves OpenBot for Notion's own consent screen — the arrow on the button says so —
where the pages and databases to share are chosen, and returns to the same page, which then reads
**Connected**.

There is no client to register and no secret to paste: the deployment introduces itself to Notion
on the first connection, over RFC 7591 dynamic client registration, and the Plugins page reports
the client as self-registered. The prerequisite is a public URL the redirect URI can be derived
from — `OPENBOT_PUBLIC_URL` if it is set, or the auth base URL it falls back to otherwise. Nothing
is registered at Notion ahead of time.

The first connection adds the app to the deployment, offered to every Bot, existing and future, and
records the tool list — reads and writes both — as the person who just consented. Unlike Google
Drive's tool list, which is OpenBot's own code, this one is an answer from Notion's hosted server and
reading it takes a credential: so it is read on the first connection, as that person, and
**Refresh tools** on `/admin/plugins/notion` reads it again later as the administrator pressing the
button, who has to have connected their own account — nobody is lent anybody else's.

An administrator can narrow the offer on `/admin/plugins/notion`: switch **Offered to every Bot**
off, and the per-Bot grants on that page decide instead. A member connecting again cannot switch it
back on. The **Connect apps** capability, on by default, turns self-service off for a role or the
whole organization.

There is deliberately no endpoint for an administrator to connect an account on somebody's behalf.

Nothing is cached. OpenBot stores the refresh token and mints a short-lived access token for each
call, so withdrawing access at Notion takes effect on the next call rather than whenever a cache
expires.

## No read-only scope

Notion has **no read-only scope**. Access is granted per page, at the moment somebody consents, not
by a scope string the way Google's `drive.readonly` is — so there is nothing at the vendor standing
behind a tool's read-or-write classification. The catalogue's write-tool list, plus the action
policy, is the **entire** write barrier for this connector.

That makes reconciling the catalogue's write-tool names against what the live list actually calls
them, whenever the list is refreshed, required rather than cosmetic. A name that has changed at the
vendor is the dangerous direction, not a safe one: `classifyTool` reads a tool Notion advertises but
that no longer matches an entry in the write list as a **read**, so an uncorrected rename quietly
turns a write into something the policy will pass through. The safe direction runs the other way — a
tool name the server never advertised at all still classifies as a write — but that is not the case
the reconciliation exists to catch.

## See also

- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — `OPENBOT_PUBLIC_URL`, `OPENBOT_APP_URL`, `KEY_ENCRYPTION_KEY`.
- [Notion's own guide](https://developers.notion.com/guides/mcp/build-mcp-client) to building an MCP
  client against its hosted server.
