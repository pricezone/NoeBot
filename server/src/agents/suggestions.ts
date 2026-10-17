/**
 * Finding a Bot template or a Marketplace item that fits what a Bot is for.
 *
 * A Bot that has just learned its job, or met a task it is badly equipped for, should be able to
 * say "there is a template for this" or "there is a plugin for this" instead of improvising. These
 * are the two finders behind that: a ranking over the package's templates and one over what the
 * Marketplace offers, each answering a short list the Bot may offer from with a card in the chat.
 *
 * LOCAL AND CHEAP ON PURPOSE. Ranking is token overlap over the names, titles, summaries and tags
 * this deployment already holds, with Greek and English folded to the same concept tokens, so a
 * query in either language meets the same English data. No model call and no network: a finder is
 * a tool a Bot may call in the middle of a turn, and it must answer in milliseconds and the same
 * way every time.
 */

import { z } from "zod";
import {
  FIND_BOT_TEMPLATES_TOOL,
  FIND_MARKETPLACE_ITEMS_TOOL,
  MARKETPLACE_MATCHES,
  type MarketplaceEligibility,
  type MarketplaceItem,
  type MarketplaceMatch,
  OFFER_BOT_TEMPLATE_TOOL,
  OFFER_MARKETPLACE_ITEM_TOOL,
  TEMPLATE_MATCHES,
  type TemplateMatch,
} from "../../../shared/suggestions";
import type { CatalogueEntry } from "../plugins/catalogue";
import {
  COMPOSIO_PLUGIN_IDS,
  CURSOR_DUPLICATE_PLUGIN_IDS,
  type IndexedPlugin,
} from "../plugins/plugin-index";
import type {
  GrantedPlugins,
  PluginRecord,
  ServerRecord,
  SkillActor,
  SkillRecord,
} from "../plugins/store";
import type { GrantedTool } from "../plugins/tools";
import { withUntrustedNotice } from "../untrusted-content";
import type { TenantTemplate } from "../tenant-package";

/* ---------------------------------------------------------------------------------------------- */
/* Normalisation                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

/** Words that say nothing about a job, in both languages (Greek without accents, final σ folded). */
const STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "assistant",
  "at",
  "be",
  "bot",
  "bots",
  "by",
  "can",
  "could",
  "do",
  "does",
  "each",
  "etc",
  "every",
  "for",
  "from",
  "get",
  "help",
  "helper",
  "helping",
  "helps",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "like",
  "mainly",
  "make",
  "me",
  "more",
  "most",
  "mostly",
  "my",
  "need",
  "needs",
  "of",
  "on",
  "one",
  "or",
  "other",
  "our",
  "out",
  "person",
  "people",
  "so",
  "some",
  "something",
  "stuff",
  "that",
  "the",
  "their",
  "them",
  "these",
  "they",
  "thing",
  "things",
  "this",
  "those",
  "to",
  "up",
  "use",
  "using",
  "want",
  "wants",
  "we",
  "what",
  "which",
  "who",
  "will",
  "with",
  "work",
  "working",
  "works",
  "would",
  "you",
  "your",
  "απο",
  "αυτα",
  "αυτο",
  "βοηθεια",
  "βοηθησ",
  "βοηθοσ",
  "για",
  "εινα",
  "ειναι",
  "ενα",
  "ενασ",
  "η",
  "θα",
  "θελω",
  "θελεισ",
  "και",
  "κατι",
  "κυριωσ",
  "μασ",
  "με",
  "μια",
  "μου",
  "να",
  "ο",
  "οι",
  "ολα",
  "οτι",
  "που",
  "πωσ",
  "σασ",
  "σε",
  "σου",
  "στα",
  "στη",
  "στην",
  "στισ",
  "στο",
  "στον",
  "στουσ",
  "τα",
  "τη",
  "την",
  "τησ",
  "τι",
  "το",
  "τον",
  "του",
  "τουσ",
  "των",
  "χρειαζομαι",
]);

/**
 * Words folded into one concept, so a query and an item that say the same thing in different words
 * still meet. One word may stand for more than one concept: "tdd" is testing and it is code.
 */
const ENGLISH_CONCEPTS: Readonly<Record<string, readonly string[]>> = {
  code: ["code"],
  coding: ["code"],
  coder: ["code"],
  program: ["code"],
  programming: ["code"],
  programmer: ["code"],
  software: ["code"],
  repo: ["code"],
  repository: ["code"],
  github: ["code", "github"],
  tdd: ["test", "code"],
  testing: ["test"],
  tests: ["test"],
  debug: ["debug", "code"],
  debugging: ["debug", "code"],
  bug: ["debug"],
  bugs: ["debug"],
  emails: ["email"],
  mail: ["email"],
  inbox: ["email"],
  gmail: ["email", "gmail"],
  meetings: ["meeting"],
  schedule: ["calendar"],
  scheduling: ["calendar"],
  sale: ["sales"],
  sales: ["sales"],
  prospect: ["sales"],
  prospects: ["sales"],
  lead: ["sales"],
  leads: ["sales"],
  crm: ["sales"],
  outreach: ["sales"],
  selling: ["sales"],
  news: ["brief"],
  briefing: ["brief"],
  briefings: ["brief"],
  digest: ["brief"],
  analytics: ["analy"],
  analysis: ["analy"],
  analyse: ["analy"],
  analyze: ["analy"],
  docs: ["document"],
  doc: ["document"],
  documents: ["document"],
  documentation: ["document"],
  website: ["web"],
  websites: ["web"],
  browser: ["web"],
  browse: ["web"],
  browsing: ["web"],
  online: ["web"],
  internet: ["web"],
  recurring: ["routine"],
  reminder: ["routine"],
  reminders: ["routine"],
  hiring: ["recruit"],
  hire: ["recruit"],
  recruiting: ["recruit"],
  recruiter: ["recruit"],
  candidates: ["candidate"],
  resume: ["cv"],
  resumes: ["cv"],
  cvs: ["cv"],
  spec: ["spec"],
  specs: ["spec"],
  specification: ["spec"],
  requirements: ["spec"],
  prd: ["spec"],
  reviews: ["review"],
  reviewer: ["review"],
  reviewing: ["review"],
  summary: ["summar"],
  summarise: ["summar"],
  summarize: ["summar"],
  summaries: ["summar"],
  translate: ["translat"],
  translation: ["translat"],
  invoices: ["invoice"],
  accounting: ["finance"],
  bookkeeping: ["finance"],
};

/** Greek stems, accents stripped, and the English concepts each one is. Longest first. */
const GREEK_CONCEPTS: readonly (readonly [string, readonly string[]])[] = [
  ["προγραμματ", ["code"]],
  ["προδιαγραφ", ["spec"]],
  ["αλληλογραφ", ["email"]],
  ["ανατροφοδοτ", ["feedback"]],
  ["περιεχομεν", ["content"]],
  ["επαναλαμβ", ["routine"]],
  ["ιστοσελιδ", ["web"]],
  ["βιογραφικ", ["cv"]],
  ["συνεντευξ", ["interview"]],
  ["ημερολογ", ["calendar"]],
  ["λογισμικ", ["code"]],
  ["ενημερωσ", ["brief"]],
  ["συναντησ", ["meeting"]],
  ["υποστηριξ", ["support"]],
  ["μαρκετινγκ", ["marketing"]],
  ["φωτογραφ", ["image"]],
  ["σημειωσ", ["note"]],
  ["κοινωνικ", ["social"]],
  ["υποψηφ", ["candidate"]],
  ["τιμολογ", ["invoice"]],
  ["δεδομεν", ["data"]],
  ["διαδικτ", ["web"]],
  ["υπενθυμ", ["routine"]],
  ["διαφημ", ["marketing"]],
  ["οικονομ", ["finance"]],
  ["συμβολαι", ["contract"]],
  ["ασφαλει", ["security"]],
  ["αναζητ", ["research"]],
  ["αναλυσ", ["analy"]],
  ["ειδησ", ["brief"]],
  ["εγγραφ", ["document"]],
  ["ερευν", ["research"]],
  ["κωδικ", ["code"]],
  ["κειμεν", ["writ"]],
  ["πωλησ", ["sales"]],
  ["πελατ", ["customer"]],
  ["μηνυμ", ["message"]],
  ["ραντεβ", ["calendar"]],
  ["συσκεψ", ["meeting"]],
  ["λογιστ", ["finance"]],
  ["ρουτιν", ["routine"]],
  ["εργασι", ["task"]],
  ["προσλ", ["recruit"]],
  ["ελεγχ", ["check"]],
  ["σφαλμ", ["debug"]],
  ["δοκιμ", ["test"]],
  ["νομικ", ["legal"]],
  ["ταξιδ", ["travel"]],
  ["μεταφρ", ["translat"]],
  ["περιληψ", ["summar"]],
  ["συνοψ", ["summar"]],
  ["εικον", ["image"]],
  ["βιντεο", ["video"]],
  ["σχολι", ["feedback"]],
  ["αρθρ", ["article"]],
  ["σχεδ", ["design"]],
  ["γραφ", ["writ"]],
  ["γραψ", ["writ"]],
];

const ENGLISH_SUFFIXES: readonly (readonly [string, string])[] = [
  ["ies", "y"],
  ["ing", ""],
  ["ers", ""],
  ["er", ""],
  ["ed", ""],
  ["es", ""],
  ["s", ""],
];

const GREEK_ENDINGS = [
  "ουσ",
  "ουν",
  "ων",
  "εσ",
  "ασ",
  "οσ",
  "ησ",
  "ου",
  "α",
  "η",
  "ο",
  "ι",
  "ε",
];

const GREEK_LETTER = /\p{Script=Greek}/u;

function stemEnglish(word: string): string {
  for (const [suffix, replacement] of ENGLISH_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length) + replacement;
    }
  }
  return word;
}

function stemGreek(word: string): string {
  for (const ending of GREEK_ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

/** One word as the concept tokens it stands for. */
function conceptsOf(word: string): readonly string[] {
  if (GREEK_LETTER.test(word)) {
    const known = GREEK_CONCEPTS.find(([stem]) => word.startsWith(stem));
    return known ? known[1] : [stemGreek(word)];
  }
  return ENGLISH_CONCEPTS[word] ?? [stemEnglish(word)];
}

/**
 * Text as the tokens a match is made of: lower case, accents stripped, final sigma folded, split on
 * anything that is not a letter or a digit, stopwords dropped, and every word as its concepts.
 * `kebab-case` and `SNAKE_CASE` split like spaces, so a skill's directory name counts.
 */
export function tokensOf(text: string): string[] {
  const plain = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ς/g, "σ");
  return plain
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word))
    .flatMap(conceptsOf);
}

/** The same concept: equal, or one a prefix of the other once both are four letters or more. */
function sameToken(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 4) return false;
  return left.startsWith(right) || right.startsWith(left);
}

/** A field of an item, weighed by how much a match in it says. */
type Field = { weight: number; tokens: readonly string[] };

const field = (weight: number, ...texts: string[]): Field => ({
  weight,
  tokens: [...new Set(texts.flatMap(tokensOf))],
});

/**
 * How well a query matches an item, 0 to 1: each query concept scores the weight of the best field
 * it appears in, over what it would score in the best field there is.
 */
export function scoreFields(query: readonly string[], fields: Field[]): number {
  const concepts = [...new Set(query)];
  if (concepts.length === 0 || fields.length === 0) return 0;
  const top = Math.max(...fields.map((each) => each.weight));
  let scored = 0;
  for (const concept of concepts) {
    let best = 0;
    for (const each of fields) {
      if (
        each.weight > best &&
        each.tokens.some((token) => sameToken(concept, token))
      ) {
        best = each.weight;
      }
    }
    scored += best;
  }
  return scored / (concepts.length * top);
}

/** Below this an item matched on a stray word, which is not a suggestion worth making. */
const MIN_SCORE = 0.08;

const rounded = (score: number) => Math.round(score * 100) / 100;

/* ---------------------------------------------------------------------------------------------- */
/* Templates                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** The strip every template this package ships is in: a provenance, not a topic. */
const PROVENANCE_CATEGORY = "From Noë Bot Team";

function templateFields(template: TenantTemplate): Field[] {
  return [
    field(3, template.name),
    field(2, template.title),
    field(
      2,
      ...template.categories.filter(
        (category) => category !== PROVENANCE_CATEGORY,
      ),
      ...template.skills,
    ),
    field(1.5, template.summary),
    field(0.75, template.description),
  ];
}

/** The templates closest to a Bot's role or a person's goal, best first, at most five. */
export function rankTemplates(
  query: string,
  templates: readonly TenantTemplate[],
  limit = TEMPLATE_MATCHES,
): TemplateMatch[] {
  const concepts = tokensOf(query);
  return templates
    .map((template) => ({
      template,
      score: scoreFields(concepts, templateFields(template)),
    }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.template.name.localeCompare(right.template.name),
    )
    .slice(0, limit)
    .map(({ template, score }) => ({
      id: template.id,
      name: template.name,
      title: template.title,
      summary: template.summary,
      score: rounded(score),
    }));
}

/* ---------------------------------------------------------------------------------------------- */
/* Marketplace                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What adding a Marketplace plugin does for a Bot right now, read off the index.
 *
 * Ready: no connector, or only connectors that need no account (a skills-only plugin is ready).
 * Optional: it has skills, and its connectors need an account the person can add later, by signing
 * in (`discover`) or pasting a key (`header`). Needs an account: anything else — a connector with
 * its own registered client (`static-client`), or connectors needing an account and no skills.
 */
export function pluginEligibility(
  plugin: Pick<IndexedPlugin, "servers" | "skills">,
): MarketplaceEligibility {
  const kinds = plugin.servers.map((server) => server.auth.kind);
  if (kinds.every((kind) => kind === "none")) return "ready";
  if (
    plugin.skills.length > 0 &&
    kinds.every(
      (kind) => kind === "none" || kind === "discover" || kind === "header",
    )
  ) {
    return "optional";
  }
  return "needs-account";
}

const ELIGIBILITY_ORDER: Record<MarketplaceEligibility, number> = {
  ready: 0,
  optional: 1,
  "needs-account": 2,
};

/** A one-line summary, cut at a word near 200 characters. */
function summaryOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 200) return flat;
  const cut = flat.slice(0, 200);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 120))}…`;
}

/** A plugin's fields and its skills' tokens, worked out once: the index never changes after boot. */
type PluginTokens = { fields: Field[]; skills: readonly (readonly string[])[] };

const pluginTokenCache = new WeakMap<IndexedPlugin, PluginTokens>();

function pluginTokens(plugin: IndexedPlugin): PluginTokens {
  const cached = pluginTokenCache.get(plugin);
  if (cached) return cached;
  const tokens: PluginTokens = {
    fields: [
      field(3, plugin.displayName, plugin.name),
      field(2, ...plugin.categories),
      field(1.5, plugin.description),
      field(1, ...plugin.skills.map((skill) => skill.name)),
      field(0.75, ...plugin.skills.map((skill) => skill.description ?? "")),
    ],
    skills: plugin.skills.map((skill) => [
      ...new Set(tokensOf(`${skill.name} ${skill.description ?? ""}`)),
    ]),
  };
  pluginTokenCache.set(plugin, tokens);
  return tokens;
}

/**
 * Breadth: a little extra for every skill that is about the query, up to a ceiling. A library with
 * five skills on writing code is a better answer to "writing code" than a vendor whose name happens
 * to contain the word, and the fields alone cannot tell the two apart.
 */
const SKILL_BONUS = 0.03;
const SKILL_BONUS_CEILING = 0.15;

function breadth(
  concepts: readonly string[],
  skills: readonly (readonly string[])[],
): number {
  const about = skills.filter((tokens) =>
    concepts.some((concept) =>
      tokens.some((token) => sameToken(concept, token)),
    ),
  ).length;
  return Math.min(SKILL_BONUS_CEILING, about * SKILL_BONUS);
}

/**
 * General-purpose plugins for a whole kind of work, and the words that ask for that work.
 *
 * Vendor plugins describe themselves in the words a task is written in ("Python", "data",
 * "debugging") and outranked the one library that is about the work itself: "Python data analysis
 * and debugging" found AWS, Snowflake and Hugging Face, and not Superpowers. When the words ask for
 * this kind of work, the library comes first. Ids are the vendored index's.
 */
const GENERAL_PURPOSE: readonly {
  pluginId: string;
  asks: readonly string[];
}[] = [
  {
    // Superpowers: test-driven development, debugging, planning and review for code work.
    pluginId: "684",
    asks: tokensOf(
      [
        "code coding coder program programming programmer developer development software",
        "debug debugging bug bugs refactor refactoring test tests testing",
        "script scripts python typescript javascript java rust golang react node",
        "repository github pull request",
        "κώδικας κώδικα προγραμματισμός προγραμματιστής αποσφαλμάτωση σφάλματα",
      ].join(" "),
    ),
  },
];

/** Enough to put the library first when the words ask for its kind of work. */
const GENERAL_BONUS = 0.5;

function generalPurpose(concepts: readonly string[], item: MarketplaceItem) {
  if (item.target.kind !== "plugin") return 0;
  const pluginId = item.target.pluginId;
  const entry = GENERAL_PURPOSE.find((each) => each.pluginId === pluginId);
  if (!entry) return 0;
  return concepts.some((concept) =>
    entry.asks.some((token) => sameToken(concept, token)),
  )
    ? GENERAL_BONUS
    : 0;
}

/** The parts of the stores a Marketplace listing is read from. Narrow, so a test can hand them in. */
export type MarketplaceSources = {
  /** The Marketplace plugins this deployment lists (`listablePlugins()`). */
  plugins: readonly IndexedPlugin[];
  catalogue: readonly CatalogueEntry[];
  installed: () => Promise<
    readonly Pick<PluginRecord, "id" | "serverIds" | "skillSlugs">[]
  >;
  servers: () => Promise<
    readonly Pick<
      ServerRecord,
      | "id"
      | "title"
      | "summary"
      | "provenance"
      | "authScheme"
      | "offeredToAllBots"
    >[]
  >;
  /** What one Bot holds, as `listForAgent` answers it. */
  held: (botId: string) => Promise<{
    tools: readonly Pick<GrantedPlugins["tools"][number], "ref">[];
    skills: readonly Pick<GrantedPlugins["skills"][number], "slug">[];
  }>;
  skills: (
    actor: SkillActor,
  ) => Promise<
    readonly Pick<
      SkillRecord,
      | "slug"
      | "title"
      | "summary"
      | "ownerUserId"
      | "pluginId"
      | "offeredToAllBots"
      | "grantedTo"
    >[]
  >;
  /** The servers this person has connected an account to, held or brokered. */
  connected: (userId: string) => Promise<ReadonlySet<string>>;
  /**
   * The Composio toolkits this deployment has added. A Cursor plugin for one of them is the same app
   * twice, and the Marketplace lists only the Composio one (`browsablePlugins`), so it is never
   * offered either. Left out, nothing counts as added.
   */
  composioToolkits?: () => Promise<ReadonlySet<string>>;
};

/** Who is looking, and for which Bot. */
export type MarketplaceViewer = {
  actor: SkillActor;
  bot: { id: string; ownerUserId: string | null };
};

type Candidate = {
  item: MarketplaceItem;
  fields: Field[];
  /** Each skill's tokens, for {@link breadth}; empty for anything that is not a plugin. */
  skills: readonly (readonly string[])[];
};

/** Prefix that keeps a skill's id apart from a catalogue key or a server id with the same name. */
const SKILL_ID_PREFIX = "skill:";

/**
 * Everything the Marketplace could offer this Bot, each with whether the Bot already holds it.
 *
 * Plugins the index lists as installable (never unavailable ones, nor ones this deployment replaced
 * with its own catalogue entry); catalogue apps reached with the person's own account; the Composio
 * apps this deployment has added that take an account; and skills of this deployment the person may
 * put on this Bot themselves.
 */
async function marketplaceCandidates(
  sources: MarketplaceSources,
  viewer: MarketplaceViewer,
): Promise<Candidate[]> {
  const [installed, servers, held, skills, connected, composioToolkits] =
    await Promise.all([
      sources.installed(),
      sources.servers(),
      sources.held(viewer.bot.id),
      sources.skills(viewer.actor),
      sources.connected(viewer.actor.id),
      sources.composioToolkits?.().catch(() => new Set<string>()) ??
        new Set<string>(),
    ]);
  const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
  const heldSkills = new Set(held.skills.map((skill) => skill.slug));
  const heldServers = new Set(held.tools.map((tool) => tool.ref.split("/")[0]));
  const offeredServers = new Set(
    servers.filter((server) => server.offeredToAllBots).map((row) => row.id),
  );

  /*
   * The duplicates the Marketplace hides are not offered: a Cursor copy of another Cursor plugin,
   * and a Cursor plugin for an app this deployment brokers through Composio, which is offered
   * instead. An installed one stays, as it does in the Marketplace.
   */
  const duplicate = (pluginId: string) => {
    if (installedById.has(pluginId)) return false;
    if (CURSOR_DUPLICATE_PLUGIN_IDS[pluginId]) return true;
    const toolkit = COMPOSIO_PLUGIN_IDS[pluginId];
    return toolkit !== undefined && composioToolkits.has(toolkit);
  };

  const plugins = sources.plugins
    .filter(
      (plugin) =>
        plugin.availability === "installable" && !duplicate(plugin.id),
    )
    .map((plugin): Candidate => {
      const record = installedById.get(plugin.id);
      // Installed, and every part of it reaches this Bot: its skills, and its connectors.
      const holds = record
        ? record.skillSlugs.every((slug) => heldSkills.has(slug)) &&
          record.serverIds.every(
            (id) => offeredServers.has(id) || heldServers.has(id),
          )
        : false;
      return {
        item: {
          id: plugin.id,
          kind: "plugin",
          name: plugin.displayName,
          summary: summaryOf(plugin.description),
          eligibility: pluginEligibility(plugin),
          skillsCount: plugin.skills.length,
          target: { kind: "plugin", pluginId: plugin.id },
          held: holds,
        },
        ...pluginTokens(plugin),
      };
    });

  const accountApp = (
    id: string,
    name: string,
    summary: string,
  ): Candidate => ({
    item: {
      id,
      kind: "plugin",
      name,
      summary: summaryOf(summary),
      eligibility: "needs-account",
      skillsCount: 0,
      target: { kind: "account", serverId: id },
      // Connected is the only state in which there is nothing left for the person to do.
      held: connected.has(id),
    },
    fields: [field(3, name), field(1.5, summary)],
    skills: [],
  });

  const catalogue = sources.catalogue
    .filter((entry) => entry.auth.kind === "user-oauth")
    .map((entry) => accountApp(entry.key, entry.title, entry.summary));

  const brokered = servers
    .filter(
      (server) =>
        server.provenance === "composio" && server.authScheme !== "NO_AUTH",
    )
    .map((server) => accountApp(server.id, server.title, server.summary));

  /*
   * A skill the person may grant through the ordinary grant route: theirs on a Bot of theirs, or
   * anything for an administrator. A plugin's skills come with the plugin, and one already offered
   * to every Bot is already on this one.
   */
  const mayGrant = (ownerUserId: string | null) =>
    viewer.actor.isAdmin ||
    (ownerUserId === viewer.actor.id &&
      viewer.bot.ownerUserId === viewer.actor.id);
  const ownSkills = skills
    .filter(
      (skill) =>
        skill.pluginId === null &&
        !skill.offeredToAllBots &&
        mayGrant(skill.ownerUserId),
    )
    .map(
      (skill): Candidate => ({
        item: {
          id: `${SKILL_ID_PREFIX}${skill.slug}`,
          kind: "skill",
          name: skill.title,
          summary: summaryOf(skill.summary),
          eligibility: "ready",
          skillsCount: 1,
          target: { kind: "skill", slug: skill.slug },
          held:
            heldSkills.has(skill.slug) ||
            skill.grantedTo.includes(viewer.bot.id),
        },
        fields: [field(3, skill.title, skill.slug), field(1.5, skill.summary)],
        skills: [],
      }),
    );

  return [...plugins, ...catalogue, ...brokered, ...ownSkills];
}

/** The items closest to a role or a task, best first, at most six, none this Bot already holds. */
export async function findMarketplaceItems(
  query: string,
  sources: MarketplaceSources,
  viewer: MarketplaceViewer,
  limit = MARKETPLACE_MATCHES,
): Promise<MarketplaceMatch[]> {
  const concepts = tokensOf(query);
  if (concepts.length === 0) return [];
  const candidates = await marketplaceCandidates(sources, viewer);
  return candidates
    .filter((candidate) => !candidate.item.held)
    .map((candidate) => ({
      item: candidate.item,
      score: Math.min(
        1,
        scoreFields(concepts, candidate.fields) +
          breadth(concepts, candidate.skills) +
          generalPurpose(concepts, candidate.item),
      ),
    }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort(
      (left, right) =>
        right.score - left.score ||
        ELIGIBILITY_ORDER[left.item.eligibility] -
          ELIGIBILITY_ORDER[right.item.eligibility] ||
        right.item.skillsCount - left.item.skillsCount ||
        left.item.name.localeCompare(right.item.name),
    )
    .slice(0, limit)
    .map(({ item }) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      summary: item.summary,
      eligibility: item.eligibility,
      skillsCount: item.skillsCount,
    }));
}

/** One item by id, held or not, for the card that offers it. Null for an id nothing here offers. */
export async function marketplaceItem(
  id: string,
  sources: MarketplaceSources,
  viewer: MarketplaceViewer,
): Promise<MarketplaceItem | null> {
  const candidates = await marketplaceCandidates(sources, viewer);
  return candidates.find((candidate) => candidate.item.id === id)?.item ?? null;
}

/* ---------------------------------------------------------------------------------------------- */
/* Tools and guidance                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * What every built-in Bot holding the finders is told, so suggesting fits later tasks as well as
 * setting a Bot up. The when and the how-often live here; each tool's description says the rest.
 */
export const SUGGESTION_GUIDANCE = [
  `When a Bot template or a Marketplace item would clearly help with your role or the task in front of you, you can find one with ${FIND_BOT_TEMPLATES_TOOL} or ${FIND_MARKETPLACE_ITEMS_TOOL} and offer it with ${OFFER_BOT_TEMPLATE_TOOL} or ${OFFER_MARKETPLACE_ITEM_TOOL}; the person decides on a card.`,
  "This applies to later tasks too, not only when you are being set up: writing code is a reason to look for Superpowers, for instance.",
  "Find first, then offer: wait for the finder's result, and offer only an id it returned, in a later step, never in the same step as the search.",
  "Offer only what clearly fits, offer once per need, and never offer again something the person declined in this conversation. Say that configuring the item later, such as connecting an account in the Marketplace, unlocks more.",
].join(" ");

/** The guidance, when the run was offered a finder; nothing otherwise. */
export function suggestionGuidance(
  tools: readonly { name: string }[],
): string | null {
  return tools.some(
    (tool) =>
      tool.name === FIND_BOT_TEMPLATES_TOOL ||
      tool.name === FIND_MARKETPLACE_ITEMS_TOOL,
  )
    ? SUGGESTION_GUIDANCE
    : null;
}

const findParameters = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "What to match: this Bot's role, or the person's goal or task, in a few words (English or Greek)",
    ),
});

const parseQuery = (args: unknown): string | null => {
  const parsed = findParameters.safeParse(args);
  return parsed.success && parsed.data.query.trim()
    ? parsed.data.query.trim()
    : null;
};

/**
 * The finders a run is offered, for one Bot and the person it works for.
 *
 * EACH ONLY BESIDE ITS OFFER TOOL. Offering is a card in the person's browser, so a finder is
 * handed to a run only when the browser registered the tool that offers what it finds (`offered`
 * is the run's browser tools). A routine, a Slack thread or a first turn has no card to draw, and a
 * finder there would only spend a tool slot on a suggestion nobody can take.
 *
 * Read-only, so they need no grant, the way asking a person needs none. Whatever the Bot finds is
 * only ever offered on a card the person answers; nothing here changes a Bot. Who is looking is
 * resolved when a finder runs rather than when the run starts, so a run that never searches pays
 * for nothing.
 */
export function suggestionTools(options: {
  templates: readonly TenantTemplate[];
  marketplace: MarketplaceSources;
  /** The Bot and its person, or null for a Bot this person cannot see. */
  viewer: () => Promise<MarketplaceViewer | null>;
  offered: readonly string[];
}): GrantedTool[] {
  const { templates, marketplace, viewer, offered } = options;
  const tools: GrantedTool[] = [];
  if (offered.includes(OFFER_BOT_TEMPLATE_TOOL) && templates.length > 0) {
    tools.push({
      name: FIND_BOT_TEMPLATES_TOOL,
      ref: `bot/${FIND_BOT_TEMPLATES_TOOL}`,
      description: [
        "Find Bot templates whose role fits this Bot's role or the person's goal. Answers up to five, best first, with a score from 0 to 1.",
        `Use it when your role is still general or the person describes what they want you for. Then offer one with ${OFFER_BOT_TEMPLATE_TOOL} only if it clearly fits; offer once, and never again if the person declined it in this conversation.`,
        "Applying a template gives this Bot its instructions, title, avatar and skills; say that the apps it names can be connected later in the Marketplace for more.",
      ].join(" "),
      parameters: findParameters,
      execute: async (args) => {
        const query = parseQuery(args);
        if (!query) return "Nothing was searched: say what to match.";
        const matches = rankTemplates(query, templates);
        return JSON.stringify({
          query,
          templates: matches,
          ...(matches.length === 0
            ? { note: "No template fits that. Do not offer one." }
            : {}),
        });
      },
    });
  }
  if (offered.includes(OFFER_MARKETPLACE_ITEM_TOOL)) {
    tools.push({
      name: FIND_MARKETPLACE_ITEMS_TOOL,
      ref: `bot/${FIND_MARKETPLACE_ITEMS_TOOL}`,
      description: [
        "Find Marketplace plugins and skills that fit this Bot's role or the task at hand, leaving out what this Bot already has. Answers up to six.",
        "eligibility says what adding one does now: ready works at once, optional adds skills now and more once an account is connected, needs-account works only after the person connects an account.",
        `Offer one with ${OFFER_MARKETPLACE_ITEM_TOOL} only when it clearly fits the role or the current task (writing code: Superpowers), once per need, never again after a decline in this conversation. Say that configuring it later in the Marketplace unlocks more.`,
      ].join(" "),
      parameters: findParameters,
      execute: async (args) => {
        const query = parseQuery(args);
        if (!query) return "Nothing was searched: say what to match.";
        const looking = await viewer();
        if (!looking)
          return "Nothing was searched: this Bot could not be read.";
        const items = await findMarketplaceItems(query, marketplace, looking);
        /*
         * Plugin names and descriptions are their publishers' words, so they arrive marked as data:
         * a description written to read like an instruction is still only a description.
         */
        return JSON.stringify(
          withUntrustedNotice(
            {
              query,
              items,
              ...(items.length === 0
                ? {
                    note: "Nothing in the Marketplace fits that. Do not offer anything.",
                  }
                : {}),
            },
            "Marketplace listing",
            ["items"],
          ),
        );
      },
    });
  }
  return tools;
}
