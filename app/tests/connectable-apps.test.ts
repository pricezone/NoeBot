import { expect, test } from "bun:test";
import {
  brokeredAccountsListedOn,
  connectableApps,
  matchingConnectableApps,
  userOAuthCatalogueOn,
} from "@/components/plugins/connectable-apps";
import type { CatalogueItem, PluginServer } from "@/lib/plugins/queries";

/**
 * Which apps the Marketplace's Apps tab offers to connect, decided without drawing anything.
 *
 * These are the Connected accounts page's own two rules, copied beside the Marketplace so the tab
 * does not import a route module. `connected-accounts-list.test.tsx` pins the original; this pins
 * the copy, so the two cannot drift apart without one of them going red.
 */

function server(overrides: Partial<PluginServer> & { id: string }) {
  return {
    title: "App",
    summary: "",
    vendor: "Composio",
    url: `composio://${overrides.id}`,
    provenance: "composio",
    authScheme: "API_KEY",
    tools: [],
    ...overrides,
  } as PluginServer;
}

function entry(overrides: Partial<CatalogueItem> & { key: string }) {
  return {
    title: "Vendor",
    vendor: "Vendor",
    summary: "Reads as you.",
    docsUrl: "https://example.com",
    auth: "user-oauth",
    perInstance: false,
    ...overrides,
  } as CatalogueItem;
}

test("a brokered app somebody connects is listed; one that needs no account is not", () => {
  expect(
    brokeredAccountsListedOn([
      server({ id: "composio-gmail", authScheme: "OAUTH2" }),
      server({ id: "composio-hackernews", authScheme: "NO_AUTH" }),
      server({ id: "composio-mystery", authScheme: null }),
      server({ id: "internal", provenance: "custom", authScheme: null }),
    ]).map((row) => row.id),
  ).toEqual(["composio-gmail", "composio-mystery"]);
});

test("only user-oauth vendors an administrator has enabled are offered", () => {
  const catalogue = [
    entry({ key: "google-drive", title: "Google Drive" }),
    entry({ key: "notion", title: "Notion" }),
    entry({ key: "github", title: "GitHub", auth: "deployment-bearer" }),
  ];
  const servers = [
    server({ id: "google-drive", provenance: "first-party" }),
    server({ id: "github", provenance: "first-party" }),
  ];
  expect(userOAuthCatalogueOn(catalogue, servers).map((e) => e.key)).toEqual([
    "google-drive",
  ]);
});

test("the rows are catalogue vendors first, then brokered apps, each with a key the detail page takes", () => {
  const rows = connectableApps({
    catalogue: [entry({ key: "google-drive", title: "Google Drive" })],
    servers: [
      server({ id: "google-drive", provenance: "first-party" }),
      server({
        id: "composio-gmail",
        title: "Gmail",
        authScheme: "OAUTH2",
        logo: "https://logo.example/gmail.png",
      }),
    ],
  });
  expect(rows.map((row) => row.key)).toEqual([
    "google-drive",
    "composio-gmail",
  ]);
  // A brokered row without a summary of its own still says what pressing it does.
  expect(rows[1]?.summary).toBe("Connect your Gmail account.");
  expect(rows[1]?.logo).toBe("https://logo.example/gmail.png");
  expect(rows[0]?.logo).toBeNull();
});

test("the search matches title or summary, case-folded, and an empty term keeps everything", () => {
  const rows = connectableApps({
    catalogue: [
      entry({ key: "google-drive", title: "Google Drive", summary: "Files." }),
    ],
    servers: [
      server({ id: "google-drive", provenance: "first-party" }),
      server({
        id: "composio-gmail",
        title: "Gmail",
        summary: "Mail and labels.",
        authScheme: "OAUTH2",
      }),
    ],
  });
  expect(matchingConnectableApps(rows, "").length).toBe(2);
  expect(matchingConnectableApps(rows, "  ").length).toBe(2);
  expect(matchingConnectableApps(rows, "LABELS").map((r) => r.key)).toEqual([
    "composio-gmail",
  ]);
  expect(matchingConnectableApps(rows, "drive").map((r) => r.key)).toEqual([
    "google-drive",
  ]);
  expect(matchingConnectableApps(rows, "slack")).toEqual([]);
});
