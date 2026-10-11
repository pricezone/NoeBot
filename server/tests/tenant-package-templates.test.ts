import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  loadTenantPackage,
  validateTenantPackage,
} from "../src/tenant-package";

/**
 * `templates.yaml`: the Bot templates a package ships, held to what they name — the package's
 * own skills, apps that exist here, the Agents tab's categories, and the featured strip's size.
 */

const BASE = {
  brand: "tenant: { id: noebot, product_name: Noë Bot }",
  agents: "agents: []",
  channels: "channels: []",
  model:
    "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
  knowledge: "sources: []",
  skills: `skills:
  - slug: check-a-claim
    title: Check a claim
    summary: Check it.
    instructions: Check the claim against a source.
`,
  themeCss: "",
};

const template = (overrides: Record<string, unknown> = {}) => ({
  id: "reading-companion",
  name: "Reading Companion",
  title: "Reading",
  categories: ["Personal"],
  summary: "Reads what you send it.",
  description: "A longer description.",
  instructions: "You are Reading Companion.",
  avatar: { color: "#2563eb", expression: "shy" },
  skills: ["check-a-claim"],
  apps: ["parallel", "55647425"],
  routines: [{ name: "Morning", summary: "Weekdays at 08:00." }],
  ...overrides,
});

const withTemplates = (...templates: Record<string, unknown>[]) =>
  validateTenantPackage({
    ...BASE,
    templates: JSON.stringify({ templates }),
  });

describe("a package's Bot templates", () => {
  test("read back as written, with the creator defaulted", () => {
    const loaded = withTemplates(template());
    expect(loaded.templates).toEqual([
      {
        id: "reading-companion",
        name: "Reading Companion",
        title: "Reading",
        creator: "Noë Bot Team",
        categories: ["Personal"],
        summary: "Reads what you send it.",
        description: "A longer description.",
        instructions: "You are Reading Companion.",
        avatar: { color: "#2563eb", expression: "shy" },
        skills: ["check-a-claim"],
        apps: ["parallel", "55647425"],
        routines: [{ name: "Morning", summary: "Weekdays at 08:00." }],
        featured: false,
      },
    ]);
    // Absent is a package with no templates, as it is for skills.
    expect(validateTenantPackage(BASE).templates).toEqual([]);
  });

  test("are held to the skills, apps, categories and avatars this deployment knows", () => {
    expect(() => withTemplates(template({ skills: ["nope"] }))).toThrow(
      'names skill "nope", which this package does not ship',
    );
    expect(() => withTemplates(template({ apps: ["slack-nope"] }))).toThrow(
      'names app "slack-nope"',
    );
    // A Marketplace plugin this deployment ships its own entry for is fine; one nothing of which
    // runs here is not an app a template may promise.
    expect(() => withTemplates(template({ apps: ["698"] }))).not.toThrow();
    expect(() => withTemplates(template({ apps: ["741"] }))).toThrow(
      'names app "741"',
    );
    expect(() => withTemplates(template({ categories: ["Fun"] }))).toThrow(
      'names category "Fun"',
    );
    expect(() => withTemplates(template({ categories: [] }))).toThrow(
      "names no category",
    );
    expect(() =>
      withTemplates(
        template({ avatar: { color: "#123456", expression: "shy" } }),
      ),
    ).toThrow("avatar.color");
    expect(() =>
      withTemplates(
        template({ avatar: { color: "#2563eb", expression: "smug" } }),
      ),
    ).toThrow("avatar.expression");
    expect(() => withTemplates(template({ id: "Bad Id" }))).toThrow(
      "template.id",
    );
    expect(() => withTemplates(template(), template())).toThrow(
      "declared twice",
    );
    expect(() => withTemplates(template({ summary: "x".repeat(141) }))).toThrow(
      "longer than 140",
    );
  });

  test("feature at most four", () => {
    const featured = ["a", "b", "c", "d", "e"].map((id) =>
      template({ id: `tpl-${id}`, featured: true }),
    );
    expect(() => withTemplates(...featured.slice(0, 4))).not.toThrow();
    expect(() => withTemplates(...featured)).toThrow("features at most 4");
  });

  test("the shipped package's templates load, and every one of them is a Bot somebody could add", async () => {
    const loaded = await loadTenantPackage(
      join(import.meta.dir, "..", "..", "examples", "noebot"),
    );
    expect(loaded.templates.length).toBeGreaterThanOrEqual(12);
    const skills = new Set(loaded.skills.map((skill) => skill.slug));
    for (const entry of loaded.templates) {
      expect(entry.categories).toContain("From Noë Bot Team");
      expect(entry.skills.every((slug) => skills.has(slug))).toBe(true);
    }
    expect(loaded.templates.filter((entry) => entry.featured)).toHaveLength(4);
  });
});
