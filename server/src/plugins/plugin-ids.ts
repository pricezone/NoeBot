/**
 * The names a Marketplace plugin's parts take in this deployment.
 *
 * A plugin's servers become `mcp_servers` rows and its skills become `skills` rows, and both of
 * those ids are contracts: a server id prefixes every tool name the model is offered and is what a
 * grant and a policy rule are written against, and a skill slug is what a person types after `/`.
 * So the ids are derived here, once, by rules the sync script applies when it writes the index and
 * the tests apply when they read it back — not chosen by a plugin author, whose `mcp.json` keys are
 * whatever they liked.
 *
 * Pure. Nothing here reads the index or the database, so both the script and the tests can ask it.
 */

/** What `addCustomServer` and `POST /skills` accept: the same rule, so a plugin's parts are ordinary rows. */
export const PLUGIN_PART_ID = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

const MAX_LENGTH = 40;

/**
 * A plugin author's name as an id this deployment can use, or null when nothing usable is left.
 *
 * Lower case; every run of anything that is not a letter or a digit becomes one hyphen; hyphens
 * at either end go; the rest is cut to the 40 characters a part id may have, and cut again at a
 * hyphen the cut left dangling. Null rather than a guess when what remains does not pass the rule
 * — a one-character name, say — because an id is a contract and an invented one is a contract
 * nobody agreed to.
 */
export function normaliseSlug(raw: string): string | null {
  let slug = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (slug.length > MAX_LENGTH) {
    slug = slug.slice(0, MAX_LENGTH).replace(/-+$/, "");
  }
  return PLUGIN_PART_ID.test(slug) ? slug : null;
}

/**
 * An id nobody holds yet: the candidate itself, or the candidate with `-2`, `-3`, … on the end.
 *
 * Two of a plugin's skills can truncate to one slug, and two plugins can mint one two-part server
 * id (`foo` + `bar`, `foo-bar` alone). The suffix keeps both, and which one gets the plain form is
 * whichever the sync script minted first — in plugin id order, so two runs agree.
 */
export function uniqueId(
  candidate: string | null,
  taken: (id: string) => boolean,
): string | null {
  if (candidate === null) return null;
  if (!taken(candidate)) return candidate;
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const trimmed = candidate
      .slice(0, MAX_LENGTH - suffix.length)
      .replace(/-+$/, "");
    const next = `${trimmed}${suffix}`;
    if (PLUGIN_PART_ID.test(next) && !taken(next)) return next;
  }
  return null;
}

/**
 * The server id for one of a plugin's MCP servers.
 *
 * The plugin's own slug when it ships one server — `treg`, `ahrefs` — because that is the name a
 * person knows the app by and the one its tools read best under. `<slug>-<server>` when it ships
 * several, or when the plain slug is already taken by another plugin (`taken` says so), so two
 * plugins can never mint the same id.
 */
export function serverIdFor(input: {
  pluginSlug: string;
  serverName: string;
  single: boolean;
  taken: (id: string) => boolean;
}): string | null {
  if (input.single && !input.taken(input.pluginSlug)) return input.pluginSlug;
  return uniqueId(
    normaliseSlug(`${input.pluginSlug}-${input.serverName}`),
    input.taken,
  );
}

/** The slug for one of a plugin's skills: `<slug>-<skill>`, since `/` names are deployment-wide. */
export function skillSlugFor(
  pluginSlug: string,
  skillName: string,
  taken: (slug: string) => boolean = () => false,
): string | null {
  return uniqueId(normaliseSlug(`${pluginSlug}-${skillName}`), taken);
}
