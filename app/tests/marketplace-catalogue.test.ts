import { expect, test } from "bun:test";
import {
  CATEGORIES,
  categoryLabel,
  installedPlugins,
  listedPlugins,
  matchingPlugins,
  pluginRowState,
  pluginSections,
  primaryCategory,
  UNCATEGORISED,
} from "@/components/plugins/marketplace-catalogue";
import type { MarketplacePlugin } from "@/lib/plugins/queries";

/**
 * How the Apps tab lays the Marketplace index out and what each row's button says, decided
 * without a DOM: Grok Bot's sections in Cursor's order, a preview per category, and a row that
 * says what is left for the person to do.
 */

function plugin(
  overrides: Partial<MarketplacePlugin> & { id: string },
): MarketplacePlugin {
  return {
    slug: overrides.id,
    name: overrides.id,
    description: "",
    publisher: "Vendor",
    verified: false,
    logoUrl: null,
    categories: [],
    availability: "installable",
    catalogueKey: null,
    servers: [],
    skills: [],
    ...overrides,
  };
}

test("a plugin is listed under its first category in the fixed order, uncategorised last", () => {
  expect(
    primaryCategory(plugin({ id: "a", categories: ["SALES", "FEATURED"] })),
  ).toBe("FEATURED");
  expect(
    primaryCategory(plugin({ id: "b", categories: ["UNKNOWN_KEY"] })),
  ).toBe(UNCATEGORISED.key);
  expect(categoryLabel("CUSTOMER_SUPPORT")).toBe("Support");
  expect(categoryLabel(UNCATEGORISED.key)).toBe("Plugins");
  expect(CATEGORIES[0]?.key).toBe("FEATURED");
});

test("sections preview four rows and say when there are more; one category is shown whole", () => {
  const research = ["a", "b", "c", "d", "e"].map((id) =>
    plugin({ id, categories: ["RESEARCH"] }),
  );
  const support = [plugin({ id: "s", categories: ["CUSTOMER_SUPPORT"] })];
  const loose = [plugin({ id: "l" })];

  const preview = pluginSections([...loose, ...research, ...support]);
  expect(
    preview.map((section) => [
      section.key,
      section.plugins.length,
      section.hasMore,
    ]),
  ).toEqual([
    ["CUSTOMER_SUPPORT", 1, false],
    ["RESEARCH", 4, true],
    ["PLUGINS", 1, false],
  ]);

  const whole = pluginSections([...loose, ...research, ...support], {
    category: "RESEARCH",
  });
  expect(whole).toHaveLength(1);
  expect(whole[0]?.plugins).toHaveLength(5);
  expect(whole[0]?.hasMore).toBe(false);
  expect(pluginSections(research, { category: "SALES" })).toEqual([]);
});

test("a catalogue plugin is not listed on its own; search reads name, description, publisher and skills", () => {
  const notion = plugin({
    id: "404",
    name: "Notion",
    availability: "catalogue",
    catalogueKey: "notion",
  });
  const treg = plugin({
    id: "treg",
    name: "Treg",
    description: "OpenRouter for tools.",
    publisher: "Superdesign",
    skills: [{ name: "seo-audit", slug: "treg-seo-audit" }],
  });
  const listed = listedPlugins({ plugins: [notion, treg] });
  expect(listed.map((entry) => entry.id)).toEqual(["treg"]);
  expect(matchingPlugins(listed, "openrouter")).toHaveLength(1);
  expect(matchingPlugins(listed, "SUPERDESIGN")).toHaveLength(1);
  expect(matchingPlugins(listed, "seo")).toHaveLength(1);
  expect(matchingPlugins(listed, "notion")).toHaveLength(0);
  expect(matchingPlugins(listed, "  ")).toHaveLength(1);
});

test("a row says Add, then whatever of the person's its servers still want, then Added", () => {
  const treg = plugin({
    id: "treg",
    servers: [
      {
        serverId: "treg",
        name: "treg",
        authKind: "header",
        variables: ["TREG_TOKEN"],
      },
    ],
  });
  const ahrefs = plugin({
    id: "ahrefs",
    servers: [
      {
        serverId: "ahrefs",
        name: "ahrefs",
        authKind: "oauth-discover",
        variables: [],
      },
    ],
  });
  const open = plugin({
    id: "open",
    servers: [
      { serverId: "open", name: "open", authKind: "none", variables: [] },
    ],
  });
  const skillsOnly = plugin({
    id: "skills",
    skills: [{ name: "x", slug: "skills-x" }],
  });
  const installed = (...ids: string[]) => ({
    installed: Object.fromEntries(ids.map((id) => [id, {} as never])),
  });

  expect(pluginRowState(treg, installed(), [])).toEqual({ kind: "add" });
  expect(pluginRowState(treg, installed("treg"), [])).toEqual({
    kind: "add-key",
    serverId: "treg",
    variables: ["TREG_TOKEN"],
  });
  expect(
    pluginRowState(treg, installed("treg"), [{ serverId: "treg" }]),
  ).toEqual({
    kind: "added",
  });
  expect(pluginRowState(ahrefs, installed("ahrefs"), [])).toEqual({
    kind: "connect",
    serverId: "ahrefs",
  });
  expect(pluginRowState(open, installed("open"), [])).toEqual({
    kind: "added",
  });
  expect(pluginRowState(skillsOnly, installed("skills"), [])).toEqual({
    kind: "added",
  });
});

test("installed plugins are the index entries the installed map names", () => {
  const a = plugin({ id: "a" });
  const b = plugin({ id: "b" });
  expect(
    installedPlugins({ plugins: [a, b], installed: { b: {} as never } }),
  ).toEqual([b]);
  expect(installedPlugins(undefined)).toEqual([]);
});
