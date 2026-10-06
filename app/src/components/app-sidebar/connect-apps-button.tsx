import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import {
  type PluginConnection,
  type PluginServer,
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/* A `string` for the reason given in account-menu.tsx: the route is another work package's. */
const MARKETPLACE_PATH: string = "/marketplace";

/** How many connected apps the pill shows faces for; the rest are implied by the word. */
export const SHOWN_APPS = 3;

/**
 * The apps to draw on the pill: the person's connections, each with the logo its server
 * publishes, first three in the server's own order. A connection whose server the catalogue no
 * longer lists still counts and draws as a plug. Exported so the rule is pinnable without a DOM.
 */
export function connectedApps(
  connections: readonly PluginConnection[] | undefined,
  servers: readonly PluginServer[] | undefined,
): { serverId: string; logo: string | null }[] {
  const logos = new Map(
    (servers ?? []).map((server) => [server.id, server.logo ?? null]),
  );
  const seen = new Set<string>();
  const apps: { serverId: string; logo: string | null }[] = [];
  for (const connection of connections ?? []) {
    if (seen.has(connection.serverId)) continue;
    seen.add(connection.serverId);
    apps.push({
      serverId: connection.serverId,
      logo: logos.get(connection.serverId) ?? null,
    });
    if (apps.length === SHOWN_APPS) break;
  }
  return apps;
}

/**
 * The "Connect apps" pill at the foot of the sidebar: the door to the Marketplace.
 *
 * Carries the faces of up to three apps this person has connected, overlapping the way Grok Bot
 * stacks them, so the pill says at a glance that something is already wired up. Logos come from
 * the plugin catalogue, which every signed-in person may read; a connection is only a server id.
 * Neither query failing changes the pill, only what rides on it.
 */
export function ConnectAppsButton() {
  const connections = useQuery(connectionsQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  const apps = connectedApps(
    connections.data?.connections,
    plugins.data?.servers,
  );

  return (
    <Button
      variant="pill"
      className="min-w-0 flex-1 justify-center gap-2"
      render={<Link to={MARKETPLACE_PATH} />}
    >
      <span className="truncate">Connect apps</span>
      {apps.length > 0 ? (
        <span
          className="flex shrink-0 items-center"
          data-testid="connected-apps"
        >
          <span className="sr-only">{`${apps.length} connected`}</span>
          {apps.map((app, index) => (
            <span
              key={app.serverId}
              className="flex size-5 items-center justify-center overflow-hidden rounded-full bg-background ring-2 ring-card [&_img]:size-4 [&_svg]:size-3"
              style={{ marginLeft: index === 0 ? 0 : -6 }}
            >
              <PluginLogo logo={app.logo} />
            </span>
          ))}
        </span>
      ) : null}
    </Button>
  );
}
