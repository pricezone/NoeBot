import { expect, test } from "bun:test";
import {
  brokeredAccountsListedOn,
  connectableAccounts,
  connectableApps,
  installedApps,
  marketplaceCatalogueOn,
  matchingConnectableApps,
} from "@/components/plugins/connectable-apps";
import type { CatalogueItem, PluginServer } from "@/lib/plugins/queries";

/**
 * Which apps the Marketplace's Apps tab offers, what pressing each does, and which count as
 * installed — decided without drawing anything.
 *
 * The rule used to be "only the `user-oauth` vendors an administrator has added a row for",
 * because the row was where the OAuth client lived. There is no administrator step now: every
 * catalogue entry a person can act on is listed, a vendor reached as you is connected whether or
 * not a row exists, and a vendor with no account to hold is enabled from the same list. These pin
 * that, and the Connected accounts page's narrower list (`connected-accounts-list.test.tsx`) pins
 * the account half of the same function.
 */

function server(overrides: Partial<PluginServer> & { id: string }) {
  return {
    title: "App",
    summary: "",
    vendor: "Composio",
    url: `composio://${overrides.id}`,
    provenance: "composio",
    authScheme: "API_KEY",
    offeredToAllBots: false,
    oauthClientSource: null,
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

/** The catalogue as the server publishes it today, one entry of each auth kind. */
const CATALOGUE = [
  entry({ key: "parallel", title: "Parallel Search", auth: "none" }),
  entry({
    key: "parallel-authenticated",
    title: "Parallel Search (API key)",
    auth: "deployment-bearer",
  }),
  entry({ key: "google-drive", title: "Google Drive" }),
  entry({ key: "notion", title: "Notion" }),
  entry({ key: "parallel-oauth", title: "Parallel Search (your account)" }),
  entry({ key: "routines", title: "Routines", auth: "builtin" }),
];

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

test("every catalogue entry except a deployment-bearer one is listed, with its kind, whether or not a row exists", () => {
  const rows = marketplaceCatalogueOn(CATALOGUE, []);
  expect(rows.map((row) => [row.key, row.kind])).toEqual([
    ["parallel", "enable"],
    ["google-drive", "account"],
    ["notion", "account"],
    ["parallel-oauth", "account"],
    ["routines", "enable"],
  ]);
  // Nothing is enabled until the deployment says so.
  expect(rows.every((row) => !row.enabled)).toBe(true);
});

test("a row is enabled only when a server row exists AND it is offered to every Bot", () => {
  const rows = marketplaceCatalogueOn(CATALOGUE, [
    server({
      id: "parallel",
      provenance: "first-party",
      offeredToAllBots: true,
    }),
    // Added by an administrator the old way: present, but granted per Bot. Not what Enable means.
    server({
      id: "routines",
      provenance: "first-party",
      offeredToAllBots: false,
    }),
    server({
      id: "google-drive",
      provenance: "first-party",
      offeredToAllBots: true,
    }),
  ]);
  const enabled = Object.fromEntries(rows.map((row) => [row.key, row.enabled]));
  expect(enabled).toEqual({
    parallel: true,
    "google-drive": true,
    notion: false,
    "parallel-oauth": false,
    routines: false,
  });
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
        offeredToAllBots: true,
      }),
    ],
  });
  expect(rows.map((row) => row.key)).toEqual([
    "google-drive",
    "composio-gmail",
  ]);
  // A brokered row is an account: the person's own, however the deployment offers it.
  expect(rows[1]?.kind).toBe("account");
  expect(rows[1]?.enabled).toBe(true);
  // A brokered row without a summary of its own still says what pressing it does.
  expect(rows[1]?.summary).toBe("Connect your Gmail account.");
  expect(rows[1]?.logo).toBe("https://logo.example/gmail.png");
  expect(rows[0]?.logo).toBeNull();
});

test("the Connected accounts page takes only the account half", () => {
  const rows = connectableAccounts({
    catalogue: CATALOGUE,
    servers: [server({ id: "composio-gmail", authScheme: "OAUTH2" })],
  });
  expect(rows.map((row) => row.key)).toEqual([
    "google-drive",
    "notion",
    "parallel-oauth",
    "composio-gmail",
  ]);
  expect(rows.every((row) => row.kind === "account")).toBe(true);
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

/*
 * "Installed" is what the counter over the Marketplace and the sidebar pill say, and it is your
 * connections plus the apps enabled for everybody that have no account to connect. An enabled
 * account app is NOT counted on its own — the deployment's half is done, yours is not — and an
 * enabled app you have also connected is one app, not two.
 */
test("installed is connections plus enabled account-less apps, nothing twice", () => {
  const page = {
    catalogue: CATALOGUE,
    servers: [
      server({
        id: "parallel",
        provenance: "first-party",
        offeredToAllBots: true,
      }),
      server({
        id: "routines",
        provenance: "first-party",
        offeredToAllBots: false,
      }),
      server({
        id: "google-drive",
        provenance: "first-party",
        offeredToAllBots: true,
      }),
      server({
        id: "composio-gmail",
        authScheme: "OAUTH2",
        logo: "https://logo.example/gmail.png",
      }),
    ],
  };
  const connections = [
    { serverId: "composio-gmail", scope: "", connectedAt: "2026-01-01" },
    { serverId: "composio-gmail", scope: "", connectedAt: "2026-01-02" },
    // A connection whose server is no longer listed still counts, and draws as a plug.
    { serverId: "composio-gone", scope: "", connectedAt: "2026-01-03" },
  ];
  expect(installedApps(page, connections)).toEqual([
    { key: "composio-gmail", logo: "https://logo.example/gmail.png" },
    { key: "composio-gone", logo: null },
    { key: "parallel", logo: null },
  ]);
  // Before either read answers there is nothing to count, and no throw.
  expect(installedApps(undefined, undefined)).toEqual([]);
});
