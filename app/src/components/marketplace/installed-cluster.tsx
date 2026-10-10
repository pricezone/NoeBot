import { IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { catalogueMarkFor } from "@/components/plugins/catalogue-marks";
import {
  type InstalledApp,
  installedApps,
} from "@/components/plugins/connectable-apps";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/** How many marks the cluster shows before it stops and lets the count speak. */
const MAX_TILES = 4;

/** The vendor's own mark where there is one, and the catalogue's mark for the key where not. */
function tileFor(app: InstalledApp) {
  if (app.logo) return <PluginLogo logo={app.logo} />;
  const Mark = catalogueMarkFor(app.key);
  return <Mark className="size-3.5" />;
}

/**
 * What is installed, at a glance: up to four overlapping marks and "{n} installed ›", which opens
 * the Connected accounts page where each account can be checked or disconnected.
 *
 * "Installed" is {@link installedApps}'s word: your own connections, plus the apps enabled for
 * everybody that have no account to connect. The same rule draws the sidebar pill, so the two
 * never disagree about the number.
 *
 * Nothing until both reads answer, rather than "0 installed" while the connections are still in
 * flight — a count is a claim, and the page has not earned it yet. A failed read draws nothing
 * either: the Apps tab below says so once, and a second sentence up here would say it twice.
 */
export function InstalledCluster() {
  const connections = useQuery(connectionsQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  if (!connections.data || !plugins.data) return null;

  const installed = installedApps(plugins.data, connections.data.connections);
  const tiles = installed.slice(0, MAX_TILES);

  return (
    <Link
      aria-label={`${installed.length} installed, open connected accounts`}
      className="flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-2 text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      data-testid="installed-cluster"
      to="/settings/connected-accounts"
    >
      {tiles.length > 0 ? (
        <span aria-hidden="true" className="flex items-center">
          {tiles.map((app, index) => (
            <span
              className={`flex size-6 items-center justify-center overflow-hidden rounded-md bg-muted ring-2 ring-card [&_img]:size-4 [&_svg]:size-3.5 ${index === 0 ? "" : "-ml-1.5"}`}
              key={app.key}
            >
              {tileFor(app)}
            </span>
          ))}
        </span>
      ) : null}
      <span>{installed.length} installed</span>
      <IconChevronRight aria-hidden="true" className="size-4" />
    </Link>
  );
}
