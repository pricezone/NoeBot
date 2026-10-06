import type {
  CatalogueItem,
  PluginServer,
  PluginsPage,
} from "@/lib/plugins/queries";

/**
 * Which apps a person can connect as themselves, decided without a DOM.
 *
 * DUPLICATED FROM `routes/_authed/_app/settings/connected-accounts/index.tsx` ON PURPOSE. The two
 * helpers below are the Connected accounts page's own rules, and the Marketplace's Apps tab lists
 * the same rows; importing a route module into a component would pull the whole settings page
 * (its `createFileRoute`, its search validation) into the Marketplace chunk for two filters. The
 * route file is also mid-move into the modal shell, so this copy is the stable import point and
 * the route can later be re-pointed at it. Both copies are pinned by tests
 * (`connected-accounts-list.test.tsx`, `connectable-apps.test.ts`), so a drift fails loudly.
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
 * The catalogue entries a person connects: only vendors reached as a person, and only ones an
 * administrator has enabled.
 *
 * A vendor with a shared token has nothing for you to decide, so it is left off; a vendor nobody
 * has enabled cannot be connected at all, because there is no OAuth client to consent against.
 */
export function userOAuthCatalogueOn(
  catalogue: CatalogueItem[],
  servers: PluginServer[],
): CatalogueItem[] {
  const added = new Set(servers.map((server) => server.id));
  return catalogue.filter(
    (entry) => entry.auth === "user-oauth" && added.has(entry.key),
  );
}

/** One row the Apps tab draws: a catalogue vendor or a brokered app, flattened to what a row needs. */
export type ConnectableApp = {
  /** The catalogue key or the server id; what `/settings/connected-accounts/$key` takes. */
  key: string;
  title: string;
  summary: string;
  /** The vendor's own mark where Composio supplies one. Null for a catalogue entry. */
  logo: string | null;
};

/** Every app a person could connect, catalogue vendors first, then brokered apps. */
export function connectableApps(
  page: Pick<PluginsPage, "catalogue" | "servers">,
): ConnectableApp[] {
  return [
    ...userOAuthCatalogueOn(page.catalogue, page.servers).map((entry) => ({
      key: entry.key,
      title: entry.title,
      summary: entry.summary,
      logo: null,
    })),
    ...brokeredAccountsListedOn(page.servers).map((server) => ({
      key: server.id,
      title: server.title,
      summary: server.summary || `Connect your ${server.title} account.`,
      logo: server.logo ?? null,
    })),
  ];
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
