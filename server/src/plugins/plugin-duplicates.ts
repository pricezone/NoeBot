import type { IndexedPlugin } from "./plugin-index";

/**
 * Which Cursor Marketplace plugins are the same app as something else this deployment offers, so
 * the Marketplace lists it once.
 *
 * Two kinds of duplicate, both decided here without the network so `scripts/sync-plugin-index.ts`
 * can propose them and a test can pin them:
 *
 * - A Cursor plugin for an app Composio also brokers (`google-calendar` and Composio's
 *   `googlecalendar`). The Composio version is kept: it connects through the deployment's own
 *   broker. The script proposes the pairs; the reviewed result is `COMPOSIO_PLUGIN_IDS`.
 * - Two Cursor plugins for one app (`customerio` and `customer-io`, `posthog` and `posthog-mcp`):
 *   the fuller one is kept. The reviewed result is `CURSOR_DUPLICATE_PLUGIN_IDS`.
 *
 * Proposals only. A slug match is a strong hint, not a proof, so both maps are committed by hand
 * after a read of the script's output, the way `CATALOGUE_PLUGIN_IDS` is.
 */

/** Suffixes and prefixes that name the packaging rather than the app. */
const PACKAGING = /^(?:mcp[-_])|(?:[-_](?:mcp|ai))$/;

/**
 * A slug or name reduced to the letters and digits that name the app: lowercase, without an
 * `mcp-` prefix or an `-mcp`/`-ai` suffix, without punctuation. `google-calendar`,
 * `googlecalendar` and `Google Calendar` all read `googlecalendar`; Composio's `_1password` reads
 * `1password`.
 */
export function matchKey(value: string): string {
  let key = value.trim().toLowerCase();
  for (let previous = ""; previous !== key; ) {
    previous = key;
    key = key.replace(PACKAGING, "");
  }
  return key.replace(/[^a-z0-9]/g, "");
}

type Candidate = Pick<
  IndexedPlugin,
  "id" | "slug" | "name" | "displayName" | "availability"
>;

/**
 * Cursor plugin id → Composio toolkit slug, for every listed Cursor plugin whose slug, name or
 * display name matches a toolkit's. Catalogue plugins are left out (they are drawn as this
 * deployment's own catalogue rows already), and so is anything in `exclude`.
 */
export function proposeComposioMatches(
  plugins: readonly Candidate[],
  toolkitSlugs: readonly string[],
  exclude: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const toolkits = new Map<string, string>();
  for (const slug of [...toolkitSlugs].sort()) {
    const key = matchKey(slug);
    if (key && !toolkits.has(key)) toolkits.set(key, slug);
  }
  const matches: Record<string, string> = {};
  for (const plugin of plugins) {
    if (plugin.availability !== "installable" || exclude.has(plugin.id)) {
      continue;
    }
    for (const field of [plugin.slug, plugin.name, plugin.displayName]) {
      const toolkit = toolkits.get(matchKey(field));
      if (toolkit) {
        matches[plugin.id] = toolkit;
        break;
      }
    }
  }
  return matches;
}

type Comparable = Candidate &
  Pick<IndexedPlugin, "servers" | "skills" | "publisher">;

/** The fuller of two plugins for one app: more parts, then a verified publisher, then the older. */
function fuller(left: Comparable, right: Comparable): Comparable {
  const parts = (plugin: Comparable) =>
    plugin.servers.length + plugin.skills.length;
  if (parts(left) !== parts(right))
    return parts(left) > parts(right) ? left : right;
  if (left.publisher.verified !== right.publisher.verified) {
    return left.publisher.verified ? left : right;
  }
  return Number(left.id) <= Number(right.id) ? left : right;
}

/**
 * Hidden Cursor plugin id → the id kept in its place, for listed plugins whose slugs share a match
 * key (`customerio`/`customer-io`, `posthog`/`posthog-mcp`).
 *
 * By slug only, not by server address: AWS publishes three different plugins (agents, databases,
 * deployments) over one knowledge server, and each brings skills of its own.
 */
export function proposeCursorDuplicates(
  plugins: readonly Comparable[],
): Record<string, string> {
  const groups = new Map<string, Comparable[]>();
  for (const plugin of plugins) {
    if (plugin.availability !== "installable") continue;
    const key = matchKey(plugin.slug);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), plugin]);
  }
  const hidden: Record<string, string> = {};
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const kept = group.reduce(fuller);
    for (const plugin of group) {
      if (plugin.id !== kept.id) hidden[plugin.id] = kept.id;
    }
  }
  return hidden;
}
