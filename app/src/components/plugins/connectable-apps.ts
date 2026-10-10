import type {
  CatalogueItem,
  PluginConnection,
  PluginServer,
  PluginsPage,
} from "@/lib/plugins/queries";

/**
 * Which apps the Marketplace offers, and what pressing each one does, decided without a DOM.
 *
 * THE ONE COPY. The Connected accounts page under Settings used to hold these rules itself, and
 * the Marketplace's Apps tab carried a duplicate so as not to import a route module; both pages
 * now read this module, and the settings page takes the account half of the same list. The rules
 * are pinned by `connectable-apps.test.ts` and `connected-accounts-list.test.tsx`.
 *
 * WHAT CHANGED, AND WHY THERE IS NO ADMIN STEP IN IT. The catalogue half used to list only the
 * `user-oauth` vendors an administrator had already added a server row for, because the row was
 * where the OAuth client lived and nothing could be consented to without one. The platform now
 * provides that client, and `/servers/:id/connect` adds the row itself, so every catalogue entry a
 * person can act on is listed whether or not anybody has touched it before — and an app that needs
 * no account at all is enabled from the same list with one press.
 */

/**
 * The brokered apps a person connects, which is not every brokered row.
 *
 * A Composio `NO_AUTH` app has no account to make: `/servers/:id/connect` refuses to create one
 * and the call gate lets it through with no row, so a row for it could never turn green. Anything
 * that is not the vendor's `NO_AUTH` is listed, an unrecorded scheme included: a row whose column
 * was never written is far likelier to be a key or consent app, and dropping it would hide a
 * connection somebody does have.
 */
export function brokeredAccountsListedOn(
  servers: PluginServer[],
): PluginServer[] {
  return servers.filter(
    (server) =>
      server.provenance === "composio" && server.authScheme !== "NO_AUTH",
  );
}

/**
 * What a row's button does.
 *
 * `account` is a vendor reached as the person asking, so the press leads to a consent screen and
 * the thing that turns green is their own connection. `enable` is a vendor reached with no
 * credential, or a capability built into this deployment: there is nothing of the person's to
 * hold, so one press enables it for everybody and the thing that turns green is the deployment.
 */
export type ConnectableAppKind = "account" | "enable";

/** One row the Apps tab draws: a catalogue vendor or a brokered app, flattened to what a row needs. */
export type ConnectableApp = {
  /** The catalogue key or the server id; what `/settings/connected-accounts/$key` takes. */
  key: string;
  title: string;
  summary: string;
  /** The vendor's own mark where Composio supplies one. Null for a catalogue entry. */
  logo: string | null;
  kind: ConnectableAppKind;
  /**
   * Whether the deployment offers this app to every Bot already.
   *
   * A server row exists and it is flagged for every Bot. For an `enable` row this is the whole of
   * its state; for an `account` row it says the deployment's half is done and the person's own
   * connection is what remains.
   */
  enabled: boolean;
};

/** Which kind of press a catalogue entry takes. Undefined for the one kind a person cannot press. */
function kindOf(entry: CatalogueItem): ConnectableAppKind | undefined {
  if (entry.auth === "user-oauth") return "account";
  if (entry.auth === "none" || entry.auth === "builtin") return "enable";
  return undefined;
}

/**
 * The catalogue entries a person can act on, each with what pressing it does and whether the
 * deployment already offers it.
 *
 * Every entry except a `deployment-bearer` one: that is a token an administrator holds for
 * everybody, and the only kind with nothing for a person to press. A `user-oauth` entry is listed
 * whether or not a server row exists yet, because connecting adds the row itself; a `none` or
 * `builtin` entry is listed so it can be enabled from here.
 */
export function marketplaceCatalogueOn(
  catalogue: CatalogueItem[],
  servers: PluginServer[],
): ConnectableApp[] {
  const rows = new Map(servers.map((server) => [server.id, server]));
  const apps: ConnectableApp[] = [];
  for (const entry of catalogue) {
    const kind = kindOf(entry);
    if (!kind) continue;
    apps.push({
      key: entry.key,
      title: entry.title,
      summary: entry.summary,
      logo: null,
      kind,
      enabled: rows.get(entry.key)?.offeredToAllBots === true,
    });
  }
  return apps;
}

/** Every app a person could connect or enable, catalogue vendors first, then brokered apps. */
export function connectableApps(
  page: Pick<PluginsPage, "catalogue" | "servers">,
): ConnectableApp[] {
  return [
    ...marketplaceCatalogueOn(page.catalogue, page.servers),
    ...brokeredAccountsListedOn(page.servers).map((server) => ({
      key: server.id,
      title: server.title,
      summary: server.summary || `Connect your ${server.title} account.`,
      logo: server.logo ?? null,
      kind: "account" as const,
      enabled: server.offeredToAllBots,
    })),
  ];
}

/**
 * The apps a person connects as themselves, which is what the Connected accounts page lists.
 *
 * The account half of {@link connectableApps} and nothing else: an app enabled for everybody has
 * no account of yours behind it, so it has no place on a page about your accounts.
 */
export function connectableAccounts(
  page: Pick<PluginsPage, "catalogue" | "servers">,
): ConnectableApp[] {
  return connectableApps(page).filter((app) => app.kind === "account");
}

/** The rows whose title or summary contains the query, case-folded. An empty query keeps them all. */
export function matchingConnectableApps(
  apps: ConnectableApp[],
  query: string,
): ConnectableApp[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return apps;
  return apps.filter((app) =>
    `${app.title} ${app.summary}`.toLocaleLowerCase().includes(needle),
  );
}

/** One app that counts as installed, with the mark the cluster and the sidebar pill draw for it. */
export type InstalledApp = {
  key: string;
  /** The vendor's own mark where Composio supplies one; null draws the catalogue mark instead. */
  logo: string | null;
};

/**
 * What "installed" means, for the counter over the Marketplace and the faces on the sidebar pill.
 *
 * The person's own connections first, in the server's order, then every app enabled for
 * everybody that has no account to connect. The second half is what the one-press Enable adds:
 * an app that reaches every Bot is installed in every sense a person cares about, and a count
 * that left it out would say "0 installed" over a Marketplace with a green row on it.
 *
 * A connection whose server the catalogue no longer lists still counts and draws as a plug.
 * Nothing is counted twice: a connection and the row it belongs to are one app.
 */
export function installedApps(
  page: Pick<PluginsPage, "catalogue" | "servers"> | undefined,
  connections: readonly PluginConnection[] | undefined,
): InstalledApp[] {
  const logos = new Map(
    (page?.servers ?? []).map((server) => [server.id, server.logo ?? null]),
  );
  const seen = new Set<string>();
  const apps: InstalledApp[] = [];
  for (const connection of connections ?? []) {
    if (seen.has(connection.serverId)) continue;
    seen.add(connection.serverId);
    apps.push({
      key: connection.serverId,
      logo: logos.get(connection.serverId) ?? null,
    });
  }
  if (page) {
    for (const app of marketplaceCatalogueOn(page.catalogue, page.servers)) {
      if (app.kind !== "enable" || !app.enabled || seen.has(app.key)) continue;
      seen.add(app.key);
      apps.push({ key: app.key, logo: null });
    }
  }
  return apps;
}
