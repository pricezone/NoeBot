import { IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/** How many marks the cluster shows before it stops and lets the count speak. */
const MAX_TILES = 4;

/**
 * The connected apps, at a glance: up to four overlapping marks and "{n} installed ›", which opens
 * the Connected accounts page where each one can be checked or disconnected.
 *
 * Nothing until both reads answer, rather than "0 installed" while the connections are still in
 * flight — a count is a claim, and the page has not earned it yet. A failed read draws nothing
 * either: the Apps tab below says so once, and a second sentence up here would say it twice.
 */
export function InstalledCluster() {
  const connections = useQuery(connectionsQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  if (!connections.data || !plugins.data) return null;

  const logoBy = new Map(
    plugins.data.servers.map((server) => [server.id, server.logo ?? null]),
  );
  const connected = connections.data.connections;
  const tiles = connected.slice(0, MAX_TILES);

  return (
    <Link
      aria-label={`${connected.length} installed, open connected accounts`}
      className="flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-2 text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      data-testid="installed-cluster"
      to="/settings/connected-accounts"
    >
      {tiles.length > 0 ? (
        <span aria-hidden="true" className="flex items-center">
          {tiles.map((connection, index) => (
            <span
              className={`flex size-6 items-center justify-center overflow-hidden rounded-md bg-muted ring-2 ring-card [&_img]:size-4 [&_svg]:size-3.5 ${index === 0 ? "" : "-ml-1.5"}`}
              key={connection.serverId}
            >
              <PluginLogo logo={logoBy.get(connection.serverId)} />
            </span>
          ))}
        </span>
      ) : null}
      <span>{connected.length} installed</span>
      <IconChevronRight aria-hidden="true" className="size-4" />
    </Link>
  );
}
