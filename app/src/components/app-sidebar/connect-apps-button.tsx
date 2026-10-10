import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { catalogueMarkFor } from "@/components/plugins/catalogue-marks";
import {
  type InstalledApp,
  installedApps,
} from "@/components/plugins/connectable-apps";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/* A `string` for the reason given in account-menu.tsx: the route is another work package's. */
const MARKETPLACE_PATH: string = "/marketplace";

/** How many installed apps the pill shows faces for; the rest are implied by the word. */
export const SHOWN_APPS = 3;

/** The vendor's own mark where there is one, and the catalogue's mark for the key where not. */
function faceFor(app: InstalledApp) {
  if (app.logo) return <PluginLogo logo={app.logo} />;
  const Mark = catalogueMarkFor(app.key);
  return <Mark className="size-3" />;
}

/**
 * The "Connect apps" pill at the foot of the sidebar: the door to the Marketplace.
 *
 * Carries the faces of up to three installed apps, overlapping the way Grok Bot stacks them, so
 * the pill says at a glance that something is already wired up. "Installed" is
 * {@link installedApps}'s word — your connections, plus the apps enabled for everybody — and the
 * same rule draws the counter over the Marketplace, so the two cannot disagree. Logos come from
 * the plugin catalogue, which every signed-in person may read; a connection is only a server id.
 * Neither query failing changes the pill, only what rides on it.
 */
export function ConnectAppsButton() {
  const connections = useQuery(connectionsQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  const apps = installedApps(plugins.data, connections.data?.connections).slice(
    0,
    SHOWN_APPS,
  );

  return (
    /*
     * A link, drawn as the pill: it goes somewhere. Drawn through Button's render prop it was
     * announced as a button, which is the wrong promise for a control whose job is to open a page.
     */
    <Link
      className={cn(
        buttonVariants({ variant: "pill" }),
        "min-w-0 flex-1 justify-center gap-2",
      )}
      to={MARKETPLACE_PATH}
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
              key={app.key}
              className="flex size-5 items-center justify-center overflow-hidden rounded-full bg-background ring-2 ring-card [&_img]:size-4 [&_svg]:size-3"
              style={{ marginLeft: index === 0 ? 0 : -6 }}
            >
              {faceFor(app)}
            </span>
          ))}
        </span>
      ) : null}
    </Link>
  );
}
