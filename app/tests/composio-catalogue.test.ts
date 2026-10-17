import { describe, expect, test } from "bun:test";
import {
  composioCategoryLabel,
  composioCategoryOf,
  composioPills,
  composioSections,
  composioToolTitle,
  OTHER_CATEGORY,
} from "@/components/plugins/composio-catalogue";
import type { ComposioApp } from "@/lib/plugins/queries";

/** Composio's directory under "Featured plugins": by category, the biggest first, Other last. */

const app = (slug: string, categories: string[]): ComposioApp => ({
  slug,
  name: slug.charAt(0).toUpperCase() + slug.slice(1),
  description: "",
  logo: null,
  categories,
  actionCount: 1,
  enabled: false,
});

const APPS = [
  app("trello", ["Productivity"]),
  app("asana", ["Productivity", "Project Management"]),
  app("notion", ["Productivity"]),
  app("linear", ["Productivity"]),
  app("clickup", ["Productivity"]),
  app("slack", ["Communication"]),
  app("miro", []),
  app("zoom", [" ", "Communication"]),
];

test("an app is filed under its first named category, or under Other", () => {
  expect(composioCategoryOf(APPS[1] as ComposioApp)).toBe("Productivity");
  expect(composioCategoryOf(APPS[6] as ComposioApp)).toBeNull();
  expect(composioCategoryOf(APPS[7] as ComposioApp)).toBe("Communication");
});

test("pills are the categories, the biggest first, Other last", () => {
  expect(composioPills(APPS).map((pill) => pill.key)).toEqual([
    "Productivity",
    "Communication",
    OTHER_CATEGORY,
  ]);
});

test("sections preview a few rows by name, and one category opens whole", () => {
  const all = composioSections(APPS, { preview: 2 });
  expect(all.map((section) => section.key)).toEqual([
    "Productivity",
    "Communication",
    OTHER_CATEGORY,
  ]);
  expect(all[0]?.apps.map((entry) => entry.slug)).toEqual(["asana", "clickup"]);
  expect(all[0]?.hasMore).toBe(true);
  expect(all[1]?.hasMore).toBe(false);

  const whole = composioSections(APPS, {
    category: "Productivity",
    preview: 2,
  });
  expect(whole).toHaveLength(1);
  expect(whole[0]?.apps).toHaveLength(5);
  expect(whole[0]?.hasMore).toBe(false);
});

test("the unfiltered view previews only the biggest categories; a search shows every one", () => {
  expect(composioSections(APPS, { sections: 1 })).toHaveLength(1);
  expect(composioSections(APPS, { sections: 1, searching: true })).toHaveLength(
    3,
  );
});

test("a tool's slug reads as a title without the app's own prefix", () => {
  expect(
    composioToolTitle("GOOGLECALENDAR_CREATE_EVENT", "googlecalendar"),
  ).toBe("Create event");
  expect(composioToolTitle("SLACK_SEND_MESSAGE", "gmail")).toBe(
    "Slack send message",
  );
  expect(composioToolTitle("", "gmail")).toBe("");
});

describe("composioCategoryLabel", () => {
  test("reads like the Cursor sections: capitalised words, initials in capitals", () => {
    expect(composioCategoryLabel("developer tools")).toBe("Developer Tools");
    expect(composioCategoryLabel("crm")).toBe("CRM");
    expect(composioCategoryLabel("artificial intelligence")).toBe(
      "Artificial Intelligence",
    );
    expect(composioCategoryLabel("model context protocol")).toBe(
      "Model Context Protocol",
    );
    expect(composioCategoryLabel("hr & recruiting")).toBe("HR & Recruiting");
    expect(composioCategoryLabel("DevOps")).toBe("DevOps");
  });
});
