import { readFileSync } from "node:fs";
import { PLUGIN_PART_ID } from "./plugin-ids";

/**
 * The vendored Marketplace index: every Cursor Marketplace plugin this build knows, as
 * `cursor-index.json` beside this file.
 *
 * WRITTEN BY A SCRIPT, READ AT BOOT, NEVER FETCHED AT RUN TIME. `scripts/sync-plugin-index.ts`
 * asks Cursor's index for the plugin list, reads each plugin's `mcp.json` at its pinned commit,
 * probes which servers are open and which want a sign-in, and writes the result here — and that
 * file is committed, so what a deployment offers is what was reviewed in a diff rather than what
 * an undocumented endpoint answered this morning. A deployment never calls cursor.com; the only
 * fetch the installer makes is a `SKILL.md` out of GitHub at the commit the index names.
 *
 * VALIDATED ON LOAD, BY HAND. The file is data this process trusts with URLs it will dial and ids
 * it will mint, so a malformed one refuses the boot in a sentence naming the field, the way the
 * tenant package does, rather than a `TypeError` an hour later when somebody presses Add.
 */

export type IndexedServerAuth =
  /** The vendor answered the unauthenticated probe with 401: sign in through its OAuth metadata. */
  | { kind: "discover"; resourceMetadataUrl: string | null }
  /** The vendor answered the probe: nothing to sign in to. */
  | { kind: "none" }
  /** A token the person pastes, filling the `${NAME}` placeholders in the server's headers. */
  | { kind: "header"; variables: string[] }
  /** The plugin names an OAuth client of its own, registered to another product's redirect. */
  | { kind: "static-client"; clientId: string; scopes: string[] };

export type IndexedServer = {
  /** The `mcp.json` key. */
  name: string;
  /** The `mcp_servers` id this server takes here; see `plugin-ids.ts`. */
  serverId: string;
  url: string;
  transport: "http" | "sse";
  /**
   * Header names to values the plugin's `mcp.json` sends on every request, with `${NAME}`
   * placeholders where a person's own token goes. Static for most servers that have any (a
   * vendor's "which client is this" header); the placeholders are what make a server `header`-auth.
   */
  headers: Record<string, string>;
  auth: IndexedServerAuth;
};

export type IndexedSkill = {
  /** The directory name under `skills/`. */
  name: string;
  /** The `skills` slug this skill takes here. */
  slug: string;
  /** The `SKILL.md`, relative to the repository root (the plugin's `gitPath` included). */
  path: string;
  /**
   * What the skill does, as Cursor's index states it (its frontmatter `description`), for the
   * plugin's page before anything is installed. Null when the index had none.
   */
  description: string | null;
};

export type IndexedVariable = {
  description: string | null;
  writeOnly: boolean;
  required: boolean;
};

export type IndexedSkippedPart = {
  kind: "server" | "skill" | "rule" | "command" | "agent" | "hook";
  name: string;
  reason: string;
};

export type PluginAvailability =
  /** At least one server or skill can be installed. */
  | "installable"
  /** Nothing of it runs here; `unavailableReason` says why. Not listed. */
  | "unavailable"
  /** This deployment ships its own entry for the same app; `catalogueKey` names it. */
  | "catalogue";

export type IndexedPlugin = {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string;
  publisher: { name: string; displayName: string; verified: boolean };
  logoUrl: string | null;
  categories: string[];
  gitUrl: string;
  gitRef: string;
  gitPath: string;
  servers: IndexedServer[];
  skills: IndexedSkill[];
  variables: Record<string, IndexedVariable>;
  skippedParts: IndexedSkippedPart[];
  availability: PluginAvailability;
  unavailableReason: string | null;
  catalogueKey: string | null;
};

export type PluginIndex = {
  source: string;
  syncedAt: string;
  plugins: IndexedPlugin[];
};

/** The three Marketplace plugins this deployment already ships an entry for, by Cursor id. */
export const CATALOGUE_PLUGIN_IDS: Readonly<Record<string, string>> =
  Object.freeze({
    "404": "notion",
    "45893413": "google-drive",
    "698": "parallel",
  });

/**
 * Cursor plugins for an app Composio also brokers: Cursor id → Composio toolkit slug.
 *
 * Proposed by `scripts/sync-plugin-index.ts` (a normalised-slug match against
 * `composio-toolkits.json`, see `plugin-duplicates.ts`) and committed after review. Where the
 * deployment has Composio configured, the Composio version is the one the Marketplace lists and
 * these are hidden from browsing (`browsablePlugins`); an installed one keeps working and stays
 * listed. Left out on review: Cursor's own Composio plugin (32661537), which is Composio itself
 * rather than an app it brokers.
 */
export const COMPOSIO_PLUGIN_IDS: Readonly<Record<string, string>> =
  Object.freeze({
    "233": "convex", // convex
    "353": "prisma", // prisma
    "407": "cloudflare", // cloudflare
    "408": "stripe", // stripe
    "512": "linear", // linear
    "579": "sentry", // sentry
    "649": "vercel", // vercel
    "651": "hex", // hex
    "653": "snowflake", // snowflake-cursor-plugin
    "657": "figma", // figma
    "674": "slack", // slack
    "717": "atlassian_mcp", // atlassian
    "730": "posthog", // posthog
    "735": "hugging_face", // huggingface-skills
    "738": "langfuse", // langfuse
    "761": "wix", // wix
    "786": "amplitude", // amplitude
    "789": "firecrawl", // firecrawl
    "800": "launch_darkly", // launchdarkly
    "1089": "pagerduty", // pagerduty
    "1090": "webflow", // webflow
    "1092": "box", // box
    "1198": "sanity", // sanity
    "1220": "gitlab", // gitlab
    "1295": "render", // render
    "1411": "datadog", // datadog
    "2046": "braintrust", // braintrust
    "2050": "postman", // postman
    "2911": "miro", // miro
    "3131": "plain", // plain
    "3165": "tavily", // tavily
    "3277": "mongodb", // mongodb
    "3777": "firebase", // firebase
    "3793": "cloudinary", // cloudinary
    "3970": "shopify", // shopify-plugin
    "4339": "pinecone", // pinecone
    "4793": "brightdata", // bright-data
    "5069": "clickup", // clickup
    "5188": "resend", // resend
    "5609": "granola_mcp", // granola
    "5636": "exa", // exa
    "5648": "mem0", // mem0
    "6067": "workos", // workos
    "6344": "temporal", // temporal
    "7619": "vantage_mcp", // vantage
    "7624": "datarobot", // datarobot-agent-skills
    "8006": "harness", // harness
    "9347": "sourcegraph", // sourcegraph-cursor-plugin
    "11976": "mixpanel", // mixpanel-mcp
    "146017": "grafana_cloud_mcp", // grafana-cloud-mcp
    "2507579": "buildkite", // buildkite
    "5420454": "higgsfield", // higgsfield
    "14372196": "heygen", // heygen
    "18281353": "raisely", // raisely
    "20992516": "netlify_mcp", // netlify-skills
    "22025095": "airtable", // airtable
    "25808295": "mintlify", // mintlify-cursor-plugin
    "26126658": "roboflow", // roboflow
    "26723531": "databricks", // databricks
    "29413143": "railway", // railway
    "32197178": "canva", // canva
    "32610026": "zoominfo", // zoominfo
    "32704904": "apollo", // apollo
    "32766883": "ramp", // ramp
    "32913266": "apify", // apify
    "33865099": "magic_patterns_mcp", // magic-patterns
    "41756884": "lucid_mcp", // lucid
    "45893410": "gmail", // gmail
    "45893411": "googlecalendar", // google-calendar
    "45893412": "googledocs", // google-docs
    "45893414": "googlesheets", // google-sheets
    "45893415": "googleslides", // google-slides
    "47477538": "browser_use", // browser-use
    "47725204": "gong", // gong
    "48668144": "agent_mail", // agentmail
    "48677658": "github", // github
    "49047809": "zoom", // zoom
    "49104326": "ashby", // ashby
    "49110469": "clay", // clay
    "49339687": "circleback_mcp", // circleback
    "49339688": "docusign", // docusign
    "49339689": "hubspot", // hubspot
    "49339690": "intercom", // intercom
    "50389919": "whop", // whop
    "50433623": "circleci", // circleci
    "52632771": "mobbin_mcp", // mobbin
    "53497710": "context_dev", // context-dev
    "53543399": "hostinger", // hostinger-cursor-plugin
    "53761261": "dropbox", // dropbox
    "56235003": "elevenlabs", // elevenlabs
    "56366542": "customerio", // customerio
    "56809965": "ahrefs", // ahrefs
    "56809966": "brevo", // brevo
    "56809967": "brex", // brex
    "56809968": "calendly", // calendly
    "56809969": "coda", // coda
    "56809970": "craft_mcp", // craft
    "56809971": "customerio", // customer-io
    "56809972": "fathom", // fathom
    "56809973": "fireflies", // fireflies
    "56809974": "godaddy_mcp", // godaddy
    "56809976": "jotform", // jotform
    "56809977": "klaviyo", // klaviyo
    "56809978": "mailerlite", // mailerlite
    "56809979": "mem", // mem
    "56809980": "mercury_mcp", // mercury
    "56809981": "otter_ai_mcp", // otter
    "56809983": "semrush", // semrush
    "56809986": "todoist", // todoist
    "56809987": "typeform", // typeform
    "56809989": "workable", // workable
    "56809990": "wrike", // wrike
    "57763987": "linq", // linq
    "58578698": "supermemory", // cursor-supermemory
    "58737848": "postiz_mcp", // postiz
    "59966080": "incident_io", // incident-io
    "60855173": "wordpress_com", // wordpress-com
    "60858255": "turso", // turso
    "60860738": "crustdata", // crustdata
    "62459236": "attio", // attio
    "62459238": "hunter", // hunter
    "63354503": "gamma", // gamma
    "63408930": "excalidraw_mcp", // excalidraw
    "63446691": "quo", // quo
    "63853950": "descript_mcp", // descript
    "65140224": "runway", // runway
    "65143440": "zernio_mcp", // zernio
    "66345229": "read_ai_mcp", // read-ai
    "66347861": "jam", // jam
    "66353838": "htmlcss_to_image", // html-css-to-image
    "66639982": "browserless", // browserless
    "66676653": "modem", // modem
    "66811936": "statsig", // statsig
    "68516158": "coinbase", // coinbase
    "68811927": "active_campaign", // activecampaign
    "68824395": "ngrok", // skills
    "68859981": "fullstory", // fullstory
    "69569192": "tinyfish", // tinyfish
    "69591832": "beehiiv", // beehiiv
    "69591833": "buffer", // buffer
    "69591835": "posthog", // posthog-mcp
    "69591836": "trello", // trello
    "70335978": "wispr_flow_mcp", // wispr-flow
    "70598720": "clarify_mcp", // clarify
    "70729788": "greenhouse", // greenhouse
    "70796588": "writer", // writer-mcp
    "70798451": "razorpay", // razorpay-remote-mcp-server
    "72150064": "mural", // mural
    "72532351": "make", // make
    "73049045": "kit", // kit
    "73501007": "context7_mcp", // context7
  });

/**
 * Cursor's own duplicates: hidden Cursor id → the id listed in its place (the fuller plugin of the
 * two, by `plugin-duplicates.ts`). Hidden whether or not Composio is configured.
 */
export const CURSOR_DUPLICATE_PLUGIN_IDS: Readonly<Record<string, string>> =
  Object.freeze({
    "56809971": "56366542", // customer-io → customerio
    "69591835": "730", // posthog-mcp → posthog
  });

export class PluginIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginIndexError";
  }
}

const fail = (where: string, what: string): never => {
  throw new PluginIndexError(`cursor-index.json: ${where}: ${what}`);
};

const asRecord = (value: unknown, where: string): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail(where, "expected an object");

const asString = (value: unknown, where: string): string =>
  typeof value === "string" ? value : fail(where, "expected a string");

const asNullableString = (value: unknown, where: string): string | null =>
  value === null || value === undefined ? null : asString(value, where);

const asBoolean = (value: unknown, where: string): boolean =>
  typeof value === "boolean" ? value : fail(where, "expected a boolean");

const asStrings = (value: unknown, where: string): string[] =>
  Array.isArray(value)
    ? value.map((item, index) => asString(item, `${where}[${index}]`))
    : fail(where, "expected a list");

const asArray = (value: unknown, where: string): unknown[] =>
  Array.isArray(value) ? value : fail(where, "expected a list");

const HTTPS = (value: string, where: string): string =>
  value.startsWith("https://") ? value : fail(where, "expected an https URL");

function parseAuth(value: unknown, where: string): IndexedServerAuth {
  const auth = asRecord(value, where);
  switch (auth.kind) {
    case "none":
      return { kind: "none" };
    case "discover":
      return {
        kind: "discover",
        resourceMetadataUrl:
          auth.resourceMetadataUrl === null ||
          auth.resourceMetadataUrl === undefined
            ? null
            : HTTPS(
                asString(
                  auth.resourceMetadataUrl,
                  `${where}.resourceMetadataUrl`,
                ),
                `${where}.resourceMetadataUrl`,
              ),
      };
    case "header": {
      const variables = asStrings(auth.variables, `${where}.variables`);
      if (variables.length === 0) {
        fail(
          `${where}.variables`,
          "a header-auth server names at least one variable",
        );
      }
      return { kind: "header", variables };
    }
    case "static-client":
      return {
        kind: "static-client",
        clientId: asString(auth.clientId, `${where}.clientId`),
        scopes: asStrings(auth.scopes, `${where}.scopes`),
      };
    default:
      return fail(
        `${where}.kind`,
        `unknown auth kind ${JSON.stringify(auth.kind)}`,
      );
  }
}

function parseServer(value: unknown, where: string): IndexedServer {
  const server = asRecord(value, where);
  const serverId = asString(server.serverId, `${where}.serverId`);
  if (!PLUGIN_PART_ID.test(serverId)) {
    fail(`${where}.serverId`, `${serverId} is not a server id`);
  }
  const declared = asString(server.transport, `${where}.transport`);
  const transport: "http" | "sse" =
    declared === "sse"
      ? "sse"
      : declared === "http"
        ? "http"
        : fail(`${where}.transport`, `unknown transport ${declared}`);
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(
    asRecord(server.headers ?? {}, `${where}.headers`),
  )) {
    headers[name] = asString(template, `${where}.headers.${name}`);
  }
  return {
    name: asString(server.name, `${where}.name`),
    serverId,
    url: HTTPS(asString(server.url, `${where}.url`), `${where}.url`),
    transport,
    headers,
    auth: parseAuth(server.auth, `${where}.auth`),
  };
}

function parseSkill(value: unknown, where: string): IndexedSkill {
  const skill = asRecord(value, where);
  const slug = asString(skill.slug, `${where}.slug`);
  if (!PLUGIN_PART_ID.test(slug)) {
    fail(`${where}.slug`, `${slug} is not a skill slug`);
  }
  const path = asString(skill.path, `${where}.path`);
  if (path.startsWith("/") || path.split("/").includes("..")) {
    fail(`${where}.path`, "must be relative and never climb");
  }
  const description =
    skill.description === undefined || skill.description === null
      ? null
      : asString(skill.description, `${where}.description`);
  return {
    name: asString(skill.name, `${where}.name`),
    slug,
    path,
    description: description?.trim() ? description.trim() : null,
  };
}

const AVAILABILITY = new Set(["installable", "unavailable", "catalogue"]);
const PART_KINDS = new Set([
  "server",
  "skill",
  "rule",
  "command",
  "agent",
  "hook",
]);

function parsePlugin(value: unknown, where: string): IndexedPlugin {
  const plugin = asRecord(value, where);
  const id = asString(plugin.id, `${where}.id`);
  if (!/^[0-9]{1,20}$/.test(id))
    fail(`${where}.id`, `${id} is not a plugin id`);
  const slug = asString(plugin.slug, `${where}.slug`);
  if (!PLUGIN_PART_ID.test(slug))
    fail(`${where}.slug`, `${slug} is not a slug`);
  const gitRef = asString(plugin.gitRef, `${where}.gitRef`);
  if (!/^[0-9a-f]{40}$/.test(gitRef)) {
    fail(`${where}.gitRef`, "expected a full commit hash");
  }
  const availability = asString(plugin.availability, `${where}.availability`);
  if (!AVAILABILITY.has(availability)) {
    fail(`${where}.availability`, `unknown availability ${availability}`);
  }
  const publisher = asRecord(plugin.publisher, `${where}.publisher`);
  const variables: Record<string, IndexedVariable> = {};
  for (const [name, raw] of Object.entries(
    asRecord(plugin.variables ?? {}, `${where}.variables`),
  )) {
    const variable = asRecord(raw, `${where}.variables.${name}`);
    variables[name] = {
      description: asNullableString(
        variable.description,
        `${where}.variables.${name}.description`,
      ),
      writeOnly: asBoolean(
        variable.writeOnly,
        `${where}.variables.${name}.writeOnly`,
      ),
      required: asBoolean(
        variable.required,
        `${where}.variables.${name}.required`,
      ),
    };
  }
  const skippedParts = asArray(
    plugin.skippedParts ?? [],
    `${where}.skippedParts`,
  ).map((raw, index) => {
    const part = asRecord(raw, `${where}.skippedParts[${index}]`);
    const kind = asString(part.kind, `${where}.skippedParts[${index}].kind`);
    if (!PART_KINDS.has(kind)) {
      fail(`${where}.skippedParts[${index}].kind`, `unknown part kind ${kind}`);
    }
    return {
      kind: kind as IndexedSkippedPart["kind"],
      name: asString(part.name, `${where}.skippedParts[${index}].name`),
      reason: asString(part.reason, `${where}.skippedParts[${index}].reason`),
    };
  });
  const logoUrl = asNullableString(plugin.logoUrl, `${where}.logoUrl`);
  const gitUrl = HTTPS(
    asString(plugin.gitUrl, `${where}.gitUrl`),
    `${where}.gitUrl`,
  );
  const gitPath = asString(plugin.gitPath ?? "", `${where}.gitPath`);
  if (gitPath.startsWith("/") || gitPath.split("/").includes("..")) {
    fail(`${where}.gitPath`, "must be relative and never climb");
  }
  return {
    id,
    slug,
    name: asString(plugin.name, `${where}.name`),
    displayName: asString(plugin.displayName, `${where}.displayName`),
    description: asString(plugin.description ?? "", `${where}.description`),
    publisher: {
      name: asString(publisher.name, `${where}.publisher.name`),
      displayName: asString(
        publisher.displayName,
        `${where}.publisher.displayName`,
      ),
      verified: asBoolean(publisher.verified, `${where}.publisher.verified`),
    },
    logoUrl: logoUrl?.startsWith("https://") ? logoUrl : null,
    categories: asStrings(plugin.categories ?? [], `${where}.categories`),
    gitUrl,
    gitRef,
    gitPath,
    servers: asArray(plugin.servers ?? [], `${where}.servers`).map(
      (raw, index) => parseServer(raw, `${where}.servers[${index}]`),
    ),
    skills: asArray(plugin.skills ?? [], `${where}.skills`).map((raw, index) =>
      parseSkill(raw, `${where}.skills[${index}]`),
    ),
    variables,
    skippedParts,
    availability: availability as PluginAvailability,
    unavailableReason: asNullableString(
      plugin.unavailableReason,
      `${where}.unavailableReason`,
    ),
    catalogueKey: asNullableString(
      plugin.catalogueKey,
      `${where}.catalogueKey`,
    ),
  };
}

/**
 * The file as the types above, or a thrown {@link PluginIndexError} naming the first field that is
 * not. Also asserts what the sync script asserts before writing — ids unique, server ids and skill
 * slugs unique across every plugin — because a hand edit can undo what the script checked.
 */
export function parsePluginIndex(value: unknown): PluginIndex {
  const root = asRecord(value, "root");
  const plugins = asArray(root.plugins, "plugins").map((raw, index) =>
    parsePlugin(raw, `plugins[${index}]`),
  );
  const ids = new Set<string>();
  // Two namespaces, because they are two tables: a server id and a skill slug may coincide.
  const serverIds = new Map<string, string>();
  const skillSlugs = new Map<string, string>();
  const claim = (
    owners: Map<string, string>,
    part: string,
    pluginId: string,
  ) => {
    const owner = owners.get(part);
    if (owner !== undefined) {
      fail("plugins", `${part} is minted by plugins ${owner} and ${pluginId}`);
    }
    owners.set(part, pluginId);
  };
  for (const plugin of plugins) {
    if (ids.has(plugin.id))
      fail("plugins", `plugin ${plugin.id} appears twice`);
    ids.add(plugin.id);
    for (const server of plugin.servers)
      claim(serverIds, server.serverId, plugin.id);
    for (const skill of plugin.skills) claim(skillSlugs, skill.slug, plugin.id);
  }
  return {
    source: asString(root.source, "source"),
    syncedAt: asString(root.syncedAt, "syncedAt"),
    plugins,
  };
}

function load(): PluginIndex {
  const text = readFileSync(
    new URL("./cursor-index.json", import.meta.url),
    "utf8",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PluginIndexError(
      `cursor-index.json is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parsePluginIndex(parsed);
}

const INDEX = load();

/** Every plugin the index holds, in id order, frozen. Includes the unavailable ones. */
export const PLUGIN_INDEX: readonly IndexedPlugin[] = Object.freeze(
  INDEX.plugins,
);

/** When the committed index was written. */
export const PLUGIN_INDEX_SYNCED_AT = INDEX.syncedAt;

const BY_ID = new Map(PLUGIN_INDEX.map((plugin) => [plugin.id, plugin]));
const BY_SERVER = new Map(
  PLUGIN_INDEX.flatMap((plugin) =>
    plugin.servers.map(
      (server) => [server.serverId, { plugin, server }] as const,
    ),
  ),
);

/** Every server id the index mints, so no custom server may take one. */
export const PLUGIN_INDEX_SERVER_IDS: ReadonlySet<string> = new Set(
  BY_SERVER.keys(),
);

export function pluginIndexEntry(id: string): IndexedPlugin | null {
  return BY_ID.get(id) ?? null;
}

export function pluginIndexServer(
  serverId: string,
): { plugin: IndexedPlugin; server: IndexedServer } | null {
  return BY_SERVER.get(serverId) ?? null;
}

/** The plugins the Marketplace lists: everything but the ones nothing of which runs here. */
export function listablePlugins(): IndexedPlugin[] {
  return PLUGIN_INDEX.filter((plugin) => plugin.availability !== "unavailable");
}

/**
 * The plugins the Marketplace offers to browse: the listable ones without the duplicates.
 *
 * A Cursor duplicate of another Cursor plugin is always left out; a Cursor plugin for an app
 * Composio brokers is left out when `composioCovers` says this deployment offers the Composio
 * version. An installed plugin is never left out, so whatever somebody already added keeps its row
 * (and keeps working: nothing here uninstalls anything). `listablePlugins` stays whole, because a
 * plugin's own page, its install and its servers are still resolved through it.
 */
export function browsablePlugins(options: {
  installed: ReadonlySet<string>;
  composioCovers: (toolkit: string) => boolean;
}): IndexedPlugin[] {
  return listablePlugins().filter((plugin) => {
    if (options.installed.has(plugin.id)) return true;
    if (CURSOR_DUPLICATE_PLUGIN_IDS[plugin.id]) return false;
    const toolkit = COMPOSIO_PLUGIN_IDS[plugin.id];
    return !(toolkit && options.composioCovers(toolkit));
  });
}
