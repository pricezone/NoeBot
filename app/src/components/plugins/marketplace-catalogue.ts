import type {
  MarketplacePage,
  MarketplacePlugin,
  PluginConnection,
} from "@/lib/plugins/queries";

/**
 * The Marketplace plugins as the Apps tab draws them, decided without a DOM.
 *
 * The server's index is a flat list with Cursor's category keys on each plugin; the tab draws it
 * the way Grok Bot does — one section per category in a fixed order, a few rows each with a "View
 * all", and a row's button saying what pressing it does next. Those rules live here, beside the
 * ones for catalogue apps in `connectable-apps.ts`, and are pinned by `marketplace-catalogue.test.ts`.
 */

/** Cursor's categories in the order its own site lists them, with the labels Grok Bot shows. */
export const CATEGORIES: readonly { key: string; label: string }[] = [
  { key: "FEATURED", label: "Featured" },
  { key: "INFRASTRUCTURE", label: "Infrastructure" },
  { key: "DATA_ANALYTICS", label: "Data & Analytics" },
  { key: "PRODUCTIVITY", label: "Productivity" },
  { key: "PAYMENTS", label: "Payments" },
  { key: "AGENT_ORCHESTRATION", label: "Agent Orchestration" },
  { key: "CANVAS", label: "Canvas" },
  { key: "INBOX_AND_COLLABORATION", label: "Inbox and Collaboration" },
  { key: "SCHEDULING", label: "Scheduling" },
  { key: "DOCUMENTS_AND_FILES", label: "Documents and Files" },
  { key: "SALES", label: "Sales" },
  { key: "CUSTOMER_SUPPORT", label: "Support" },
  { key: "FINANCE_AND_LEGAL", label: "Finance and Legal" },
  { key: "RESEARCH", label: "Research" },
  { key: "DESIGN", label: "Design" },
];

/** Where a plugin with no category of its own is listed. */
export const UNCATEGORISED = { key: "PLUGINS", label: "Plugins" } as const;

/** How many rows a category shows before "View all". */
export const PREVIEW_ROWS = 4;

/** The label for a category key, for a heading or a pill. */
export function categoryLabel(key: string): string {
  return (
    CATEGORIES.find((category) => category.key === key)?.label ??
    (key === UNCATEGORISED.key ? UNCATEGORISED.label : key)
  );
}

/** A plugin's first category in the fixed order, which is the section it is listed under. */
export function primaryCategory(
  plugin: Pick<MarketplacePlugin, "categories">,
): string {
  for (const category of CATEGORIES) {
    if (plugin.categories.includes(category.key)) return category.key;
  }
  return UNCATEGORISED.key;
}

/** What pressing a plugin's row does next. */
export type PluginRowState =
  /** Not installed: Add installs it for every Bot. */
  | { kind: "add" }
  /** Installed, and one of its OAuth servers wants this person's sign-in. */
  | { kind: "connect"; serverId: string }
  /** Installed, and one of its header servers wants this person's token. */
  | { kind: "add-key"; serverId: string; variables: string[] }
  /** Installed, and nothing of this person's is missing. */
  | { kind: "added" };

/**
 * What a plugin's row says, from whether it is installed and which of its servers the person has
 * connected.
 *
 * Servers are taken in the plugin's order and the first that wants something of the person's
 * decides; an open server wants nothing. A plugin with only skills is added and done.
 */
export function pluginRowState(
  plugin: MarketplacePlugin,
  page: Pick<MarketplacePage, "installed">,
  connections: readonly Pick<PluginConnection, "serverId">[],
): PluginRowState {
  if (!page.installed[plugin.id]) return { kind: "add" };
  const connected = new Set(connections.map((row) => row.serverId));
  for (const server of plugin.servers) {
    if (connected.has(server.serverId)) continue;
    if (
      server.authKind === "oauth-discover" ||
      server.authKind === "static-client"
    ) {
      return { kind: "connect", serverId: server.serverId };
    }
    if (server.authKind === "header") {
      return {
        kind: "add-key",
        serverId: server.serverId,
        variables: server.variables,
      };
    }
  }
  return { kind: "added" };
}

/** The plugins the tab lists: every installable one. A `catalogue` plugin is drawn as its catalogue row. */
export function listedPlugins(
  page: Pick<MarketplacePage, "plugins">,
): MarketplacePlugin[] {
  return page.plugins.filter((plugin) => plugin.availability === "installable");
}

/** The plugins whose name, description, publisher or skills contain the query. Empty keeps them all. */
export function matchingPlugins(
  plugins: MarketplacePlugin[],
  query: string,
): MarketplacePlugin[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return plugins;
  return plugins.filter((plugin) =>
    [
      plugin.name,
      plugin.description,
      plugin.publisher,
      ...plugin.skills.map((skill) => skill.name),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export type PluginSection = {
  key: string;
  label: string;
  plugins: MarketplacePlugin[];
  /** Whether the section holds more than it shows, so "View all" has somewhere to go. */
  hasMore: boolean;
};

/**
 * The sections the tab draws: one per category in the fixed order, uncategorised last, each
 * holding its first few plugins unless one category is shown in full.
 */
export function pluginSections(
  plugins: MarketplacePlugin[],
  options: { category?: string | undefined; preview?: number } = {},
): PluginSection[] {
  const preview = options.preview ?? PREVIEW_ROWS;
  const byCategory = new Map<string, MarketplacePlugin[]>();
  for (const plugin of plugins) {
    const key = primaryCategory(plugin);
    const bucket = byCategory.get(key) ?? [];
    bucket.push(plugin);
    byCategory.set(key, bucket);
  }
  const order = [
    ...CATEGORIES.map((category) => category.key),
    UNCATEGORISED.key,
  ];
  const sections: PluginSection[] = [];
  for (const key of order) {
    const bucket = byCategory.get(key);
    if (!bucket || bucket.length === 0) continue;
    if (options.category !== undefined && options.category !== key) continue;
    const whole = options.category === key;
    sections.push({
      key,
      label: categoryLabel(key),
      plugins: whole ? bucket : bucket.slice(0, preview),
      hasMore: !whole && bucket.length > preview,
    });
  }
  return sections;
}

/** The installed plugins, as the installed counter and the sidebar pill count them. */
export function installedPlugins(
  page: Pick<MarketplacePage, "plugins" | "installed"> | undefined,
): MarketplacePlugin[] {
  if (!page) return [];
  return page.plugins.filter(
    (plugin) => page.installed[plugin.id] !== undefined,
  );
}
