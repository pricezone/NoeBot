import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  matchKey,
  proposeComposioMatches,
  proposeCursorDuplicates,
} from "../src/plugins/plugin-duplicates";
import {
  browsablePlugins,
  COMPOSIO_PLUGIN_IDS,
  CURSOR_DUPLICATE_PLUGIN_IDS,
  type IndexedPlugin,
  listablePlugins,
  PLUGIN_INDEX,
} from "../src/plugins/plugin-index";

/**
 * Which Cursor plugins duplicate a Composio toolkit or another Cursor plugin, as the sync script
 * proposes them, and the reviewed maps the Marketplace hides by.
 */

const TOOLKITS: string[] = JSON.parse(
  readFileSync(
    new URL("../src/plugins/composio-toolkits.json", import.meta.url),
    "utf8",
  ),
).slugs;

function plugin(
  overrides: Partial<IndexedPlugin> & { id: string; slug: string },
) {
  return {
    name: overrides.slug,
    displayName: overrides.slug,
    availability: "installable" as const,
    servers: [],
    skills: [],
    publisher: { name: "x", displayName: "X", verified: false },
    ...overrides,
  } as IndexedPlugin;
}

describe("the match key", () => {
  test("reads an app's name the same however it is spelled or packaged", () => {
    expect(matchKey("google-calendar")).toBe("googlecalendar");
    expect(matchKey("googlecalendar")).toBe("googlecalendar");
    expect(matchKey("Google Calendar")).toBe("googlecalendar");
    expect(matchKey("posthog-mcp")).toBe("posthog");
    expect(matchKey("mcp-posthog")).toBe("posthog");
    expect(matchKey("read_ai_mcp")).toBe("read");
    expect(matchKey("_1password")).toBe("1password");
    expect(matchKey("incident-io")).toBe("incidentio");
  });
});

describe("proposals", () => {
  test("a Cursor plugin pairs with the Composio toolkit for the same app", () => {
    expect(
      proposeComposioMatches(
        [
          plugin({ id: "1", slug: "google-calendar" }),
          plugin({ id: "2", slug: "posthog-mcp" }),
          plugin({
            id: "3",
            slug: "snowflake-cursor-plugin",
            name: "x",
            displayName: "Snowflake",
          }),
          plugin({ id: "4", slug: "something-else" }),
          // Drawn as this deployment's own catalogue row, and ruled out on review.
          plugin({ id: "5", slug: "google-drive", availability: "catalogue" }),
          plugin({ id: "6", slug: "composio" }),
        ],
        ["googlecalendar", "posthog", "snowflake", "googledrive", "composio"],
        new Set(["6"]),
      ),
    ).toEqual({ "1": "googlecalendar", "2": "posthog", "3": "snowflake" });
  });

  test("two Cursor plugins for one app keep the fuller, and one server shared by different plugins is not a duplicate", () => {
    const server = (url: string) =>
      ({ url }) as IndexedPlugin["servers"][number];
    const skill = { name: "s", slug: "s", path: "s", description: null };
    expect(
      proposeCursorDuplicates([
        plugin({ id: "730", slug: "posthog", skills: [skill] }),
        plugin({ id: "69591835", slug: "posthog-mcp" }),
        plugin({
          id: "650",
          slug: "deploy-on-aws",
          servers: [server("https://knowledge.aws")],
        }),
        plugin({
          id: "6198",
          slug: "databases-on-aws",
          servers: [server("https://knowledge.aws")],
        }),
      ]),
    ).toEqual({ "69591835": "730" });
  });
});

describe("the reviewed maps", () => {
  const listable = new Map(listablePlugins().map((entry) => [entry.id, entry]));

  test("name listed Cursor plugins and toolkits Composio publishes", () => {
    for (const [id, toolkit] of Object.entries(COMPOSIO_PLUGIN_IDS)) {
      expect(listable.get(id)?.availability).toBe("installable");
      expect(TOOLKITS).toContain(toolkit);
    }
    for (const [hidden, kept] of Object.entries(CURSOR_DUPLICATE_PLUGIN_IDS)) {
      expect(listable.has(hidden)).toBe(true);
      expect(listable.has(kept)).toBe(true);
    }
  });

  test("agree with what the sync script proposes for the committed index (update both together)", () => {
    expect(
      proposeComposioMatches(PLUGIN_INDEX, TOOLKITS, new Set(["32661537"])),
    ).toEqual({ ...COMPOSIO_PLUGIN_IDS });
    expect(proposeCursorDuplicates(PLUGIN_INDEX)).toEqual({
      ...CURSOR_DUPLICATE_PLUGIN_IDS,
    });
  });
});

describe("browsing", () => {
  const ids = (options: Parameters<typeof browsablePlugins>[0]) =>
    new Set(browsablePlugins(options).map((entry) => entry.id));

  test("hides Cursor's own duplicates always, and a Composio app's only where it is covered", () => {
    const none = ids({ installed: new Set(), composioCovers: () => false });
    expect(none.has("56809971")).toBe(false);
    expect(none.has("45893411")).toBe(true);
    const covered = ids({
      installed: new Set(),
      composioCovers: (toolkit) => toolkit === "googlecalendar",
    });
    expect(covered.has("45893411")).toBe(false);
    expect(covered.has("45893410")).toBe(true);
  });

  test("never hides what is installed", () => {
    const kept = ids({
      installed: new Set(["45893411", "56809971"]),
      composioCovers: () => true,
    });
    expect(kept.has("45893411")).toBe(true);
    expect(kept.has("56809971")).toBe(true);
  });
});
