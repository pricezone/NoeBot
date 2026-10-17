/**
 * One sweep: rewrite `src/plugins/cursor-index.json` from the Cursor Marketplace.
 *
 * Noë Bot's Marketplace apps are Cursor Marketplace plugins — a public GitHub repository at a
 * pinned commit, with remote MCP servers in `mcp.json` and skills under `skills/` — and Cursor's
 * index lists them at `POST https://cursor.com/api/dashboard/list-marketplace-plugins`,
 * undocumented and without authentication. That endpoint is asked HERE, by whoever runs this
 * script, and never by a deployment: what a deployment offers is the committed file, reviewed in a
 * diff, so an endpoint that changes shape breaks this script on somebody's laptop and not every
 * instance at boot.
 *
 * Per plugin it reads the MCP configuration out of the repository at the pinned commit, reads
 * every dialect of it into one shape (`src/plugins/mcp-config.ts`), decides which servers a
 * server of ours could dial and why the rest cannot, probes each candidate once without a
 * credential to learn whether it is open or wants a sign-in, and mints the ids the parts take
 * here (`src/plugins/plugin-ids.ts`) — in plugin id order, after every fetch is in, so two runs
 * over the same marketplace write the same ids. Nothing secret is written: a header holding a
 * literal credential skips the server, and a plugin's own `CLIENT_SECRET` is never read.
 *
 *   cd server && bun scripts/sync-plugin-index.ts [--no-probe] [--only <id>[,<id>]]
 *
 * `--no-probe` keeps each server's auth classification from the committed file (or `discover`
 * where there is none) instead of asking the vendor. `--only` processes the named plugins and
 * prints them rather than writing the file. Exits non-zero when the index could not be fetched or
 * the result fails its own invariants, and writes nothing in either case.
 *
 * DUPLICATES. Every sweep ends by proposing which Cursor plugins duplicate a Composio toolkit (a
 * normalised-slug match against `src/plugins/composio-toolkits.json`) or another Cursor plugin, and
 * prints how that differs from the reviewed maps in `plugin-index.ts` (`COMPOSIO_PLUGIN_IDS`,
 * `CURSOR_DUPLICATE_PLUGIN_IDS`), which are updated by hand after a read. Two flags help with that:
 *
 *   cd server && bun scripts/sync-plugin-index.ts --duplicates           # committed index, offline
 *   cd server && bun scripts/sync-plugin-index.ts --composio-toolkits    # refresh the toolkit list
 *
 * `--composio-toolkits` rewrites the toolkit list from Composio's public docs sitemap (every
 * `docs.composio.dev/toolkits/<slug>` page; their API wants a key) and then proposes, offline.
 *
 * THE PRODUCT'S NAME. Cursor's index is read by another client too, and some authors name it in
 * their descriptions. Every sweep rewrites that name to Noë Bot in the text a person reads
 * (`src/plugins/rebrand.ts`), so the committed file never says otherwise; `--rebrand` applies the
 * same rewrite to the committed file, offline, without a sweep:
 *
 *   cd server && bun scripts/sync-plugin-index.ts --rebrand              # committed index, offline
 */
import { renameSync, writeFileSync } from "node:fs";
import { extractResourceMetadataUrl } from "@modelcontextprotocol/sdk/client/auth.js";
import { CATALOGUE } from "../src/plugins/catalogue";
import {
  fetchGithubRaw,
  githubRepositoryOf,
  joinRepositoryPath,
} from "../src/plugins/github-raw";
import {
  type ParsedMcpConfig,
  type ParsedServer,
  parseMcpConfig,
  type SkippedPart,
} from "../src/plugins/mcp-config";
import {
  normaliseSlug,
  serverIdFor,
  skillSlugFor,
} from "../src/plugins/plugin-ids";
import {
  proposeComposioMatches,
  proposeCursorDuplicates,
} from "../src/plugins/plugin-duplicates";
import {
  CATALOGUE_PLUGIN_IDS,
  COMPOSIO_PLUGIN_IDS,
  CURSOR_DUPLICATE_PLUGIN_IDS,
  type IndexedPlugin,
  type IndexedServer,
  type IndexedServerAuth,
  type IndexedSkill,
  type IndexedVariable,
  type PluginIndex,
  parsePluginIndex,
} from "../src/plugins/plugin-index";
import { rebrandPlugin } from "../src/plugins/rebrand";

const INDEX_URL = "https://cursor.com/api/dashboard/list-marketplace-plugins";
const OUTPUT = new URL("../src/plugins/cursor-index.json", import.meta.url);
const TOOLKITS = new URL(
  "../src/plugins/composio-toolkits.json",
  import.meta.url,
);
const TOOLKITS_SITEMAP = "https://docs.composio.dev/sitemap.xml";
/** Cursor plugins a slug match pairs with a toolkit but review ruled out: not the same app. */
const NOT_COMPOSIO_DUPLICATES = new Set([
  // Cursor's Composio plugin is Composio itself, not one of the apps it brokers.
  "32661537",
]);
const CONCURRENCY = 8;
const PROBE_TIMEOUT_MS = 10_000;
const COMMIT = /^[0-9a-f]{40}$/;

type RawPart = { name?: unknown; sourcePath?: unknown; description?: unknown };

type RawPlugin = {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  description?: unknown;
  logoUrl?: unknown;
  publisher?: { name?: unknown; displayName?: unknown; isVerified?: unknown };
  gitUrl?: unknown;
  gitRef?: unknown;
  gitPath?: unknown;
  curatedCategoryKeys?: unknown;
  variables?: unknown;
  minClientVersions?: Record<string, unknown>;
  skills?: RawPart[];
  mcpServers?: RawPart[];
  rules?: RawPart[];
  commands?: RawPart[];
  subagents?: RawPart[];
  hooks?: RawPart[];
};

/** What the concurrent pass learns about one plugin, before any id is minted. */
type Fetched = {
  raw: RawPlugin;
  base: Omit<
    IndexedPlugin,
    "servers" | "skills" | "skippedParts" | "availability" | "unavailableReason"
  >;
  /** Set when nothing of the plugin can be installed; the sequential pass writes it as is. */
  unavailable: string | null;
  servers: { parsed: ParsedServer; auth: IndexedServerAuth }[];
  skills: { name: string; path: string; description: string | null }[];
  skippedParts: SkippedPart[];
};

/** How much of a skill's description the index keeps; Cursor's run to about 280 characters. */
const SKILL_DESCRIPTION_CHARS = 400;

const args = process.argv.slice(2);
const noProbe = args.includes("--no-probe");
const duplicatesOnly = args.includes("--duplicates");
const refreshToolkits = args.includes("--composio-toolkits");
const rebrandOnly = args.includes("--rebrand");
const onlyIndex = args.indexOf("--only");
const only =
  onlyIndex === -1
    ? null
    : new Set((args[onlyIndex + 1] ?? "").split(",").filter(Boolean));

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

async function readPreviousIndex(): Promise<PluginIndex | null> {
  try {
    return parsePluginIndex(await Bun.file(OUTPUT).json());
  } catch {
    return null;
  }
}

async function fetchIndex(): Promise<RawPlugin[]> {
  const response = await fetch(INDEX_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Cursor's index answered ${response.status}`);
  }
  const body = (await response.json()) as { plugins?: unknown };
  if (!Array.isArray(body.plugins)) {
    throw new Error("Cursor's index answered without a plugins list");
  }
  return body.plugins as RawPlugin[];
}

/**
 * The MCP configuration, read from the first of the places a plugin keeps it.
 *
 * The API's `mcpServers[].sourcePath` names the file when Cursor resolved one; `.cursor-plugin/
 * plugin.json` may hold the map inline or name a file; `mcp.json` and `.mcp.json` are the two
 * conventional names. All repository-root-relative.
 */
async function readMcpConfig(
  repo: { owner: string; repo: string },
  gitRef: string,
  gitPath: string,
  raw: RawPlugin,
): Promise<{ config: ParsedMcpConfig | null; missing: boolean }> {
  const read = async (path: string): Promise<unknown | null> => {
    const result = await fetchGithubRaw({ ...repo, ref: gitRef, path });
    if (!result.ok) return null;
    try {
      return JSON.parse(result.text);
    } catch {
      return null;
    }
  };

  const named = [
    ...new Set(
      (raw.mcpServers ?? [])
        .map((server) => text(server.sourcePath))
        .filter(Boolean),
    ),
  ];
  const candidates = [
    ...named,
    joinRepositoryPath(gitPath, ".cursor-plugin/plugin.json"),
    joinRepositoryPath(gitPath, "mcp.json"),
    joinRepositoryPath(gitPath, ".mcp.json"),
  ];

  for (const path of [...new Set(candidates)]) {
    const parsed = await read(path);
    if (parsed === null || typeof parsed !== "object") continue;
    const object = parsed as Record<string, unknown>;

    if (path.endsWith("plugin.json")) {
      // The manifest: `mcpServers` inline, or a path (or list of either) relative to the plugin root.
      const declared = object.mcpServers;
      if (declared === undefined) continue;
      const pieces = Array.isArray(declared) ? declared : [declared];
      const merged: Record<string, unknown> = {};
      let found = false;
      for (const piece of pieces) {
        if (typeof piece === "string") {
          const nested = await read(joinRepositoryPath(gitPath, piece));
          const map =
            nested && typeof nested === "object"
              ? ((nested as Record<string, unknown>).mcpServers ?? nested)
              : null;
          if (map && typeof map === "object") {
            Object.assign(merged, map as Record<string, unknown>);
            found = true;
          }
        } else if (piece && typeof piece === "object") {
          Object.assign(merged, piece as Record<string, unknown>);
          found = true;
        }
      }
      if (found) {
        return {
          config: parseMcpConfig({ mcpServers: merged }),
          missing: false,
        };
      }
      continue;
    }

    return { config: parseMcpConfig(parsed), missing: false };
  }

  return { config: null, missing: (raw.mcpServers ?? []).length > 0 };
}

/** Whether the vendor wants a sign-in, learned from one unauthenticated request. */
async function probe(
  server: ParsedServer,
): Promise<
  | { kind: "none" }
  | { kind: "discover"; resourceMetadataUrl: string | null }
  | null
> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  let response: Response;
  try {
    response =
      server.transport === "sse"
        ? await fetch(server.url, {
            headers,
            redirect: "manual",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          })
        : await fetch(server.url, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "openbot-index", version: "1" },
              },
            }),
            redirect: "manual",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
  } catch {
    return null;
  }
  // The body is never read: an SSE stream would stay open, and nothing in it is needed.
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    let resourceMetadataUrl: string | null = null;
    try {
      const found = extractResourceMetadataUrl(response);
      resourceMetadataUrl =
        found && found.protocol === "https:" ? found.toString() : null;
    } catch {
      resourceMetadataUrl = null;
    }
    return { kind: "discover", resourceMetadataUrl };
  }
  if (response.ok) return { kind: "none" };
  return null;
}

function variablesOf(raw: unknown): Record<string, IndexedVariable> {
  const schema =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
  );
  const variables: Record<string, IndexedVariable> = {};
  for (const [name, value] of Object.entries(properties)) {
    const property =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    const description =
      text(property.description) || text(property.title) || null;
    variables[name] = {
      description,
      writeOnly: property.writeOnly === true,
      required: required.has(name),
    };
  }
  return variables;
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await work(items[index] as T, index);
      }
    }),
  );
  return results;
}

/** The concurrent pass: everything about one plugin that needs the network. */
async function fetchPlugin(
  plugin: RawPlugin,
  previousAuth: Map<string, IndexedServerAuth>,
): Promise<Fetched> {
  const id = text(plugin.id);
  const name = text(plugin.name);
  const gitRef = text(plugin.gitRef);
  const gitPath = joinRepositoryPath(text(plugin.gitPath));
  const gitUrl = text(plugin.gitUrl);
  const base: Fetched["base"] = {
    id,
    slug: normaliseSlug(name) ?? `plugin-${id}`,
    name,
    displayName: text(plugin.displayName) || name,
    description: text(plugin.description),
    publisher: {
      name: text(plugin.publisher?.name),
      displayName:
        text(plugin.publisher?.displayName) || text(plugin.publisher?.name),
      verified: plugin.publisher?.isVerified === true,
    },
    logoUrl: text(plugin.logoUrl).startsWith("https://")
      ? text(plugin.logoUrl)
      : null,
    categories: Array.isArray(plugin.curatedCategoryKeys)
      ? plugin.curatedCategoryKeys.filter(
          (key): key is string => typeof key === "string",
        )
      : [],
    gitUrl: gitUrl || "https://github.com/",
    gitRef: COMMIT.test(gitRef) ? gitRef : "0".repeat(40),
    gitPath,
    variables: variablesOf(plugin.variables),
    catalogueKey: CATALOGUE_PLUGIN_IDS[id] ?? null,
  };
  const unavailable = (reason: string): Fetched => ({
    raw: plugin,
    base,
    unavailable: reason,
    servers: [],
    skills: [],
    skippedParts: [],
  });

  // Cursor's own keys for the clients that read its index, verbatim: they are its API's field
  // names, not prose, so the rebrand never touches them.
  const clients = plugin.minClientVersions ?? {};
  if (clients.sand === "never" || clients.grokbot === "never") {
    return unavailable("hidden");
  }
  if (!normaliseSlug(name)) return unavailable("no-id");
  if (!COMMIT.test(gitRef)) return unavailable("unpinned");
  const repo = githubRepositoryOf(gitUrl);
  if (!repo) return unavailable("url-refused");

  const { config, missing } = await readMcpConfig(
    repo,
    gitRef,
    gitPath,
    plugin,
  );
  const skippedParts: SkippedPart[] = [...(config?.skipped ?? [])];
  if (missing && !config) {
    for (const server of plugin.mcpServers ?? []) {
      skippedParts.push({
        kind: "server",
        name: text(server.name) || "mcp",
        reason: "mcp-config-missing",
      });
    }
  }
  for (const [kind, parts] of [
    ["rule", plugin.rules],
    ["command", plugin.commands],
    ["agent", plugin.subagents],
    ["hook", plugin.hooks],
  ] as const) {
    for (const part of parts ?? []) {
      skippedParts.push({
        kind,
        name: text(part.name) || kind,
        reason: "unsupported-in-v1",
      });
    }
  }

  const servers: Fetched["servers"] = [];
  for (const parsed of config?.servers ?? []) {
    let auth: IndexedServerAuth;
    if (parsed.variables.length > 0) {
      auth = { kind: "header", variables: parsed.variables };
    } else if (parsed.staticClient) {
      auth = { kind: "static-client", ...parsed.staticClient };
    } else {
      const probed = noProbe ? null : await probe(parsed);
      const remembered = previousAuth.get(parsed.url);
      auth =
        probed ??
        (remembered &&
        (remembered.kind === "none" || remembered.kind === "discover")
          ? remembered
          : { kind: "discover", resourceMetadataUrl: null });
    }
    servers.push({ parsed, auth });
  }

  const skills: Fetched["skills"] = [];
  for (const skill of plugin.skills ?? []) {
    const skillName = text(skill.name);
    if (!skillName) {
      skippedParts.push({ kind: "skill", name: "skill", reason: "no-id" });
      continue;
    }
    // Cursor's index carries each skill's frontmatter description; kept so a plugin's page can say
    // what a skill does before anybody installs it, without a read of GitHub.
    const description = text(skill.description).trim();
    skills.push({
      name: skillName,
      path:
        text(skill.sourcePath) ||
        joinRepositoryPath(gitPath, "skills", skillName, "SKILL.md"),
      description: description
        ? description.slice(0, SKILL_DESCRIPTION_CHARS)
        : null,
    });
  }

  return {
    raw: plugin,
    base,
    unavailable: null,
    servers,
    skills,
    skippedParts,
  };
}

/** The vendored Composio toolkit slugs. */
async function readToolkits(): Promise<string[]> {
  const file = (await Bun.file(TOOLKITS).json()) as { slugs?: unknown };
  if (
    !Array.isArray(file.slugs) ||
    !file.slugs.every((slug) => typeof slug === "string")
  ) {
    throw new Error(
      "composio-toolkits.json: slugs: expected a list of strings",
    );
  }
  return file.slugs;
}

/** Rewrites `composio-toolkits.json` from the toolkit pages Composio's docs sitemap lists. */
async function refreshToolkitList(): Promise<void> {
  const response = await fetch(TOOLKITS_SITEMAP);
  if (!response.ok) {
    throw new Error(`${TOOLKITS_SITEMAP} answered ${response.status}`);
  }
  const sitemap = await response.text();
  const slugs = [
    ...new Set(
      [
        ...sitemap.matchAll(/docs\.composio\.dev\/toolkits\/([a-z0-9_]+)</g),
      ].map((match) => match[1] as string),
    ),
  ].sort();
  if (slugs.length < 100) {
    throw new Error(
      `${TOOLKITS_SITEMAP} listed only ${slugs.length} toolkits; not overwriting the list`,
    );
  }
  writeFileSync(
    TOOLKITS.pathname,
    `${JSON.stringify(
      { source: TOOLKITS_SITEMAP, syncedAt: new Date().toISOString(), slugs },
      null,
      2,
    )}\n`,
  );
  console.error(`wrote ${TOOLKITS.pathname}: ${slugs.length} toolkits`);
}

/** How a proposed map differs from the committed one, as lines a reviewer reads. */
function mapDrift(
  name: string,
  proposed: Record<string, string>,
  committed: Readonly<Record<string, string>>,
  plugins: readonly IndexedPlugin[],
): string[] {
  const slugOf = (id: string) =>
    plugins.find((plugin) => plugin.id === id)?.slug ?? "?";
  const lines: string[] = [];
  for (const [id, target] of Object.entries(proposed)) {
    if (committed[id] !== target) {
      lines.push(`${name} + "${id}": "${target}", // ${slugOf(id)}`);
    }
  }
  for (const [id, target] of Object.entries(committed)) {
    if (proposed[id] !== target) {
      lines.push(`${name} - "${id}": "${target}", // ${slugOf(id)}`);
    }
  }
  return lines;
}

/** Proposes both duplicate maps for an index and prints how they differ from the reviewed ones. */
async function reportDuplicates(plugins: readonly IndexedPlugin[]) {
  const composio = proposeComposioMatches(
    plugins,
    await readToolkits(),
    NOT_COMPOSIO_DUPLICATES,
  );
  const cursor = proposeCursorDuplicates(plugins);
  const drift = [
    ...mapDrift("COMPOSIO_PLUGIN_IDS", composio, COMPOSIO_PLUGIN_IDS, plugins),
    ...mapDrift(
      "CURSOR_DUPLICATE_PLUGIN_IDS",
      cursor,
      CURSOR_DUPLICATE_PLUGIN_IDS,
      plugins,
    ),
  ];
  console.error(
    `duplicates: ${Object.keys(composio).length} Composio, ${Object.keys(cursor).length} Cursor; ${
      drift.length === 0
        ? "the reviewed maps in plugin-index.ts agree"
        : "review these against plugin-index.ts:"
    }`,
  );
  for (const line of drift) console.error(`  ${line}`);
}

/** The index as this script writes it: two-space JSON and a final newline. */
function serialiseIndex(index: PluginIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/** Replaces the committed file in one rename, so a reader never sees half of it. */
function writeIndex(index: PluginIndex): void {
  const temporary = `${OUTPUT.pathname}.tmp`;
  writeFileSync(temporary, serialiseIndex(index));
  renameSync(temporary, OUTPUT.pathname);
  console.error(`wrote ${OUTPUT.pathname}`);
}

/**
 * `--rebrand`: the committed index with the sweep's rewrite applied, and nothing else changed — not
 * `syncedAt`, not an auth, not an id — so the diff is the sentences and only the sentences.
 */
async function rebrandCommittedIndex(): Promise<void> {
  const committed = (await Bun.file(OUTPUT).json()) as PluginIndex;
  parsePluginIndex(committed);
  const index: PluginIndex = {
    ...committed,
    plugins: committed.plugins.map(rebrandPlugin),
  };
  parsePluginIndex(index);
  const changed = index.plugins.filter(
    (plugin, at) =>
      JSON.stringify(plugin) !== JSON.stringify(committed.plugins[at]),
  ).length;
  console.error(`rebrand: ${changed} plugins changed`);
  writeIndex(index);
}

async function main() {
  if (rebrandOnly) {
    await rebrandCommittedIndex();
    return;
  }
  const previous = await readPreviousIndex();
  if (refreshToolkits) await refreshToolkitList();
  if (duplicatesOnly || refreshToolkits) {
    if (!previous) throw new Error("cursor-index.json could not be read");
    await reportDuplicates(previous.plugins);
    return;
  }

  const previousAuth = new Map<string, IndexedServerAuth>();
  for (const plugin of previous?.plugins ?? []) {
    for (const server of plugin.servers) {
      previousAuth.set(server.url, server.auth);
    }
  }

  const raw = await fetchIndex();
  console.error(`index: ${raw.length} plugins`);
  const selected = (
    only ? raw.filter((plugin) => only.has(text(plugin.id))) : raw
  ).sort((left, right) => Number(text(left.id)) - Number(text(right.id)));

  const fetched = await mapWithLimit(selected, CONCURRENCY, (plugin) =>
    fetchPlugin(plugin, previousAuth),
  );

  /*
   * THE SEQUENTIAL PASS MINTS EVERY ID, in plugin id order, against one set of what is taken.
   *
   * Which plain slugs are spoken for before any server id is minted: every plugin's own slug,
   * every catalogue key, and the broker's namespace. A single-server plugin takes its own slug as
   * the server id unless another plugin already owns that word. Server ids and skill slugs are
   * two namespaces (two tables), each unique on its own.
   */
  const pluginSlugs = new Map<string, string>();
  for (const plugin of raw) {
    const slug = normaliseSlug(text(plugin.name));
    if (slug && !pluginSlugs.has(slug)) pluginSlugs.set(slug, text(plugin.id));
  }
  const reserved = new Set<string>([
    ...CATALOGUE.map((entry) => entry.key),
    "composio",
  ]);
  const mintedServerIds = new Set<string>();
  const mintedSkillSlugs = new Set<string>();

  const plugins: IndexedPlugin[] = fetched.map((item) => {
    const { base, skippedParts } = item;
    if (item.unavailable) {
      return {
        ...base,
        servers: [],
        skills: [],
        skippedParts,
        availability: "unavailable",
        unavailableReason: item.unavailable,
      };
    }
    const serverTaken = (candidate: string) =>
      reserved.has(candidate) ||
      candidate.startsWith("composio-") ||
      mintedServerIds.has(candidate) ||
      (pluginSlugs.has(candidate) && pluginSlugs.get(candidate) !== base.id);

    const servers: IndexedServer[] = [];
    for (const { parsed, auth } of item.servers) {
      const serverId = serverIdFor({
        pluginSlug: base.slug,
        serverName: parsed.name,
        single: item.servers.length === 1,
        taken: serverTaken,
      });
      if (!serverId) {
        skippedParts.push({
          kind: "server",
          name: parsed.name,
          reason: "no-id",
        });
        continue;
      }
      mintedServerIds.add(serverId);
      servers.push({
        name: parsed.name,
        serverId,
        url: parsed.url,
        transport: parsed.transport,
        headers: parsed.headers,
        auth,
      });
    }

    const skills: IndexedSkill[] = [];
    for (const skill of item.skills) {
      const slug = skillSlugFor(base.slug, skill.name, (candidate) =>
        mintedSkillSlugs.has(candidate),
      );
      if (!slug) {
        skippedParts.push({ kind: "skill", name: skill.name, reason: "no-id" });
        continue;
      }
      mintedSkillSlugs.add(slug);
      skills.push({
        name: skill.name,
        slug,
        path: skill.path,
        description: skill.description,
      });
    }

    const availability = base.catalogueKey
      ? "catalogue"
      : servers.length > 0 || skills.length > 0
        ? "installable"
        : "unavailable";
    const firstServerReason = skippedParts.find(
      (part) => part.kind === "server",
    )?.reason;
    return {
      ...base,
      servers,
      skills,
      skippedParts,
      availability,
      unavailableReason:
        availability === "unavailable"
          ? (firstServerReason ?? "no-remote-parts")
          : null,
    };
  });

  const index: PluginIndex = {
    source: "cursor-marketplace",
    syncedAt: new Date().toISOString(),
    // Authors' words, shown in our Marketplace: the product they name is this one.
    plugins: plugins.map(rebrandPlugin),
  };
  // The same validation the loader runs at boot, so a file this script writes is one it accepts.
  parsePluginIndex(index);
  await reportDuplicates(plugins);

  const count = (predicate: (plugin: IndexedPlugin) => boolean) =>
    plugins.filter(predicate).length;
  const tally = (keys: string[]) =>
    keys.reduce<Record<string, number>>((acc, key) => {
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  console.error(
    JSON.stringify({
      counts: {
        installable: count((plugin) => plugin.availability === "installable"),
        catalogue: count((plugin) => plugin.availability === "catalogue"),
        unavailable: count((plugin) => plugin.availability === "unavailable"),
        servers: plugins.reduce(
          (sum, plugin) => sum + plugin.servers.length,
          0,
        ),
        skills: plugins.reduce((sum, plugin) => sum + plugin.skills.length, 0),
      },
      reasons: tally(
        plugins.flatMap((plugin) =>
          plugin.unavailableReason ? [plugin.unavailableReason] : [],
        ),
      ),
      auths: tally(
        plugins.flatMap((plugin) =>
          plugin.servers.map((server) => server.auth.kind),
        ),
      ),
    }),
  );

  if (only) {
    process.stdout.write(serialiseIndex(index));
    return;
  }
  writeIndex(index);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
