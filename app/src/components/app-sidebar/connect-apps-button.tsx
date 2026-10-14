import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { FEATURED_APP_LOGOS } from "@/components/plugins/brand-logos";
import { catalogueMarkFor } from "@/components/plugins/catalogue-marks";
import {
  type InstalledApp,
  installedApps,
} from "@/components/plugins/connectable-apps";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { buttonVariants } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/* A `string` for the reason given in account-menu.tsx: the route is another work package's. */
const MARKETPLACE_PATH: string = "/marketplace";

/** How many faces the pill shows; the rest are implied by the word. */
export const SHOWN_APPS = 3;

/** The vendor's own mark where there is one, and the catalogue's mark for the key where not. */
function faceFor(app: InstalledApp) {
  if (app.logo) return <PluginLogo logo={app.logo} />;
  const Mark = catalogueMarkFor(app.key);
  return <Mark className="size-3" />;
}

/** One face on the pill: a 20px circle, overlapping the one before it. */
type Face = { key: string; title: string; node: React.ReactNode };

/**
 * The faces the pill wears: the person's installed apps first, then — up to three in all — the
 * trio Grok Bot's own pill always shows, Gmail, Notion and Google Drive, skipping any already
 * on it. Pure, so the order can be pinned without a DOM.
 */
export function pillFaces(apps: readonly InstalledApp[]): Face[] {
  const faces: Face[] = apps.slice(0, SHOWN_APPS).map((app) => ({
    key: app.key,
    title: app.key,
    node: faceFor(app),
  }));
  for (const { key, title, Logo } of FEATURED_APP_LOGOS) {
    if (faces.length >= SHOWN_APPS) break;
    if (faces.some((face) => face.key === key)) continue;
    faces.push({ key, title, node: <Logo className="size-3" /> });
  }
  return faces;
}

/**
 * The "Connect apps" pill at the foot of the sidebar: the door to the Marketplace.
 *
 * Carries three faces, overlapping the way Grok Bot stacks them: the apps already wired up
 * first — "installed" is {@link installedApps}'s word, your connections plus the apps enabled
 * for everybody, the same rule that draws the counter over the Marketplace — and, until there are
 * three of those, the trio Grok Bot's pill always shows, so the button says what it is for before
 * anything is connected. Logos come from the plugin catalogue, which every signed-in person may
 * read; a connection is only a server id. Neither query failing changes the pill, only what rides
 * on it.
 */
export function ConnectAppsButton() {
  const { t } = useTranslation();
  const connections = useQuery(connectionsQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  const apps = installedApps(plugins.data, connections.data?.connections);
  const faces = pillFaces(apps);
  const connected = Math.min(apps.length, SHOWN_APPS);

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
      <span className="truncate">{t("Connect apps")}</span>
      <span className="flex shrink-0 items-center" data-testid="connected-apps">
        {connected > 0 ? (
          <span className="sr-only">{`${connected} connected`}</span>
        ) : null}
        {faces.map((face, index) => (
          <span
            className="flex size-5 items-center justify-center overflow-hidden rounded-full bg-background ring-2 ring-card [&_img]:size-4 [&_svg]:size-3"
            data-face={face.key}
            key={face.key}
            style={{ marginLeft: index === 0 ? 0 : -6 }}
            title={face.title}
          >
            {face.node}
          </span>
        ))}
      </span>
    </Link>
  );
}
