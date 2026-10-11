import { IconCheck } from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { PluginRowState } from "@/components/plugins/marketplace-catalogue";
import { Button, buttonVariants } from "@/components/ui/button";
import type { MarketplacePlugin } from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/** The round, small action every Marketplace row carries. */
export const ACTION_CLASS = "h-8 rounded-full px-3 text-xs";

/** The same action, at the size a plugin's own page draws it. */
const PAGE_CLASS = "h-10 rounded-full px-5 text-sm";

/**
 * What pressing a plugin does next — Add, Connect, Add key, or nothing because it is Added — drawn
 * from the state `pluginRowState` decided. One component for the row and for the plugin's page,
 * so the two never disagree about what is left for the person to do.
 *
 * `install` is the tab's own mutation rather than one of this component's, because the row's
 * refused-press sentence lives above the rows, not inside the one pressed; the page's lives above
 * its header for the same reason.
 */
export function PluginAction({
  plugin,
  state,
  install,
  onAddKey,
  onError,
  appearance = "row",
}: {
  plugin: Pick<MarketplacePlugin, "id" | "name">;
  state: PluginRowState;
  install: Pick<
    UseMutationResult<unknown, Error, string>,
    "isPending" | "variables" | "mutate"
  >;
  onAddKey: (serverId: string) => void;
  onError: (message: string | null) => void;
  appearance?: "row" | "page";
}) {
  const className = appearance === "page" ? PAGE_CLASS : ACTION_CLASS;
  const size = appearance === "page" ? "default" : "sm";
  const adding = install.isPending && install.variables === plugin.id;

  if (state.kind === "add") {
    return (
      <Button
        aria-label={`Add ${plugin.name}`}
        className={className}
        disabled={adding}
        onClick={() => {
          onError(null);
          install.mutate(plugin.id);
        }}
        size={size}
        type="button"
        variant={appearance === "page" ? "default" : "secondary"}
      >
        {adding ? "Adding…" : "Add"}
      </Button>
    );
  }
  if (state.kind === "connect") {
    return (
      <Link
        aria-label={`Connect ${plugin.name}`}
        className={cn(
          buttonVariants({ size, variant: "secondary" }),
          className,
        )}
        params={{ key: state.serverId }}
        to="/settings/connected-accounts/$key"
      >
        Connect
      </Link>
    );
  }
  if (state.kind === "add-key") {
    return (
      <Button
        aria-label={`Add key for ${plugin.name}`}
        className={className}
        onClick={() => {
          onError(null);
          onAddKey(state.serverId);
        }}
        size={size}
        type="button"
        variant="secondary"
      >
        Add key
      </Button>
    );
  }
  return <AddedMark appearance={appearance} title={plugin.name} />;
}

/** The state of an installed plugin with nothing left to do; removing it is on its own page. */
export function AddedMark({
  title,
  appearance = "row",
}: {
  title: string;
  appearance?: "row" | "page";
}) {
  return (
    <span
      aria-label={`${title} added`}
      className={cn(
        "flex items-center gap-1 text-muted-foreground",
        appearance === "page" ? "h-10 px-4 text-sm" : "h-8 px-3 text-xs",
      )}
      role="status"
    >
      <IconCheck
        aria-hidden="true"
        className="size-3.5 text-emerald-600 dark:text-emerald-400"
      />
      Added
    </span>
  );
}
