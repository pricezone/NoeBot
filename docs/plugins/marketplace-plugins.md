# Marketplace plugins

Noë Bot's Marketplace lists the plugins of the [Cursor Marketplace](https://cursor.com/marketplace). A plugin is a public GitHub repository pinned to a commit, with remote MCP servers in its `mcp.json` and skills under `skills/<name>/SKILL.md`. Any signed-in person presses **Add** on one from **Connect apps → Apps**, and its servers and skills are offered to every Bot on the deployment — the same thing connecting a catalogue app does. The tab has a row of category pills under the search (the biggest categories, the rest behind **More**), Cursor's curated set first as **Recommended for you**, and a row that opens the plugin's own page — its source at the pinned commit, each connector and what it asks of you, each skill and what it does, and **Remove plugin** for whoever added it or an administrator.

## Where the list comes from

The list is a file in this repository, `server/src/plugins/cursor-index.json`, written by

```
cd server && bun scripts/sync-plugin-index.ts
```

The script asks Cursor's index for the plugin list, reads each plugin's `mcp.json` out of GitHub at the pinned commit, reads every dialect of it into one shape, probes each remote server once without a credential to learn whether it is open or wants a sign-in, and mints the ids the parts take here. The result is committed and reviewed in a diff; a running deployment never calls cursor.com. The only fetch a deployment makes is each `SKILL.md`, out of GitHub, at the commit the index names, when somebody presses Add.

Run the script again to pick up new plugins; `--no-probe` keeps the auth classification from the committed file, and `--only <id>` prints one plugin without writing. Each skill's `description` is Cursor's own (its `SKILL.md` frontmatter, as the index reports it), kept so a plugin's page can say what a skill does before anybody installs it.

Cursor's index is read by another client too, and a few authors name it in their descriptions. Every sweep rewrites that name to Noë Bot in the text a person reads — display names and the plugin, skill and variable descriptions, never names, slugs, URLs or ids (`server/src/plugins/rebrand.ts`). `--rebrand` applies the same rewrite to the committed file offline and changes nothing else, and `app/tests/product-name.test.ts` fails if the old name turns up in the index or anywhere else in the repository.

## What installs, and what does not

Of a plugin, this deployment installs its **remote MCP servers** (Streamable HTTP or SSE) and its **skills**. Rules, commands, agents and hooks are Cursor-editor features and are left out; the install records them under *skipped parts*.

A plugin is listed only if something of it runs on a server of ours. These do not, and are hidden:

- servers that run a program on the computer (`command` rather than `url`, like Parallel's `parallel-cli` or Kraken's CLI);
- servers behind Cursor's own proxies (`api.cursor.com/rest-mcp/*` — Gmail, Google Drive, Outlook, Teams) or xAI's gateway;
- servers whose address fails the same floor an administrator's typed URL has to pass (https only, no internal names, no credential in the address), or whose address itself is a placeholder;
- plugins not pinned to a commit.

Three plugins are the same apps this deployment ships its own entries for — Notion, Google Drive, Parallel — and the Marketplace shows the catalogue's row for those.

## How a plugin server is reached

The index classifies each server once, and the install writes it on the row (`mcp_servers.auth_kind`):

| `auth_kind` | What `mcp.json` said | What a person does |
| --- | --- | --- |
| `none` | no auth, and the probe was answered | nothing — it is available as soon as it is added |
| `oauth-discover` | no auth, and the probe answered 401 | **Connect**: the vendor's OAuth metadata is discovered (RFC 9728, then RFC 8414 / OpenID), the deployment registers itself where the vendor offers it (RFC 7591), and the person signs in with PKCE |
| `header` | a header with a `${VARIABLE}` | **Add key**: the person pastes the value(s); they are held in the vault under that person and rendered into the headers per request |
| `static-client` | an `auth.CLIENT_ID` of the plugin's own | as `oauth-discover`, except the plugin's client is another product's and is not used: a platform-provided client (`OPENBOT_PLUGIN_OAUTH_CLIENT_<SERVER_ID>_ID`, see [configuration](../configuration.md)) or the vendor's own registration endpoint stands in |

Every one of these is one person's own: a header token or a grant is never shared between people, and a call made for somebody who has not connected is refused with the step to take.

Discovered endpoints are cached on the row for seven days and must pass the URL floor too. A vendor that publishes none, or one that does not support PKCE, cannot be connected and says so.

Tools a plugin's server lists are classified by the vendor's own `readOnlyHint` and `destructiveHint` annotations, as Cursor classifies them; a server an administrator added by URL is still not believed about its own read-only tools. Writes go through the same approval policy as every other tool.

## A vendor that will not register this deployment

An OAuth server whose index entry says `discover` is reached through its own metadata (RFC 9728 and RFC 8414) and a client this deployment registers at the vendor (RFC 7591) with its callback as the redirect URI, under the product's name. Some vendors register only redirect URIs on their own allowlist — Vercel's MCP (`mcp.vercel.com`) answers `invalid_redirect_uri: The provided redirect URIs are not approved for use by this authorization server` to anybody but the clients it knows. Connect then answers 502 with the vendor's sentence, and the log carries `oauth-registration-refused`; there is nothing to configure on this side. Linear, Sentry and the others that register anybody go straight to their consent screen.

## Removing

A plugin's servers and skills leave only with the plugin: the person who installed it, or an administrator, removes it from the connected-accounts page, which ends every account connected to its servers and takes the skills with it. An administrator can still narrow what a plugin's servers and skills reach from the Plugins screens (*Offered to every Bot*), as for any other app.
