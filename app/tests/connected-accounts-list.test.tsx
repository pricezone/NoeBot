import { expect, test } from "bun:test";
import { connectableAccounts } from "@/components/plugins/connectable-apps";
import type { CatalogueItem, PluginServer } from "@/lib/plugins/queries";

/**
 * Which apps the Connected accounts page lists, decided without drawing anything.
 *
 * The page is about accounts of yours, so it takes the account half of the Marketplace's list and
 * nothing else: a vendor reached as you from the catalogue, whether or not anybody has added a
 * row for it yet, and a brokered app somebody connects. What it leaves out is as much the rule as
 * what it keeps — an app enabled for everybody has no account of yours behind it, a vendor with a
 * shared token has nothing for you to decide, and a Composio `NO_AUTH` app has no account to
 * make, so a row for it could never turn green.
 *
 * WHAT THAT LAST ONE PUT ON EVERY PERSON'S PAGE, before the rule existed, was a permanently grey
 * "Not connected" row for an app nobody can connect, which reads as an unfinished task. Clicking
 * it landed on a page that said the app needs no account and drew no button, so the list and the
 * page it opened contradicted each other — and the list was the more believable of the two.
 *
 * The page used to hold this rule itself; it reads `connectableAccounts` now, which
 * `connectable-apps.test.ts` pins from the Marketplace's side.
 */

/** A minimal but complete `PluginServer`, overridable per case. */
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

const keysOf = (page: Parameters<typeof connectableAccounts>[0]) =>
  connectableAccounts(page).map((row) => row.key);

test("a brokered app somebody connects is listed", () => {
  expect(
    keysOf({
      catalogue: [],
      servers: [
        server({ id: "composio-gmail", authScheme: "OAUTH2" }),
        server({ id: "composio-linear", authScheme: "API_KEY" }),
      ],
    }),
  ).toEqual(["composio-gmail", "composio-linear"]);
});

test("a brokered app that needs no account is not listed", () => {
  expect(
    keysOf({
      catalogue: [],
      servers: [
        server({ id: "composio-hackernews", authScheme: "NO_AUTH" }),
        server({ id: "composio-gmail", authScheme: "OAUTH2" }),
      ],
    }),
  ).toEqual(["composio-gmail"]);
});

/**
 * AND A ROW WITH NO RECORDED SCHEME IS STILL LISTED, which is the deliberate direction.
 *
 * A brokered row whose column was never written — restored, or made before the column existed — is
 * far likelier to be a key or consent app than a no-auth one, and dropping it here would hide a
 * connection somebody does have from the only page that offers to disconnect it.
 */
test("a brokered app with no recorded scheme is still listed", () => {
  expect(
    keysOf({
      catalogue: [],
      servers: [server({ id: "composio-mystery", authScheme: null })],
    }),
  ).toEqual(["composio-mystery"]);
});

test("a server that is not brokered at all is never listed as an account on its own", () => {
  expect(
    keysOf({
      catalogue: [],
      servers: [
        server({
          id: "internal",
          provenance: "custom",
          url: "https://mcp.example.com/mcp",
          authScheme: null,
        }),
      ],
    }),
  ).toEqual([]);
});

/*
 * The catalogue half: every vendor reached as you, row or no row, and nothing that is not. No
 * administrator step stands before Connect any more, so a vendor nobody has touched is as much
 * yours to connect as one somebody has.
 */
test("a user-oauth vendor is listed whether or not a row exists; the other kinds are not", () => {
  expect(
    keysOf({
      catalogue: [
        entry({ key: "parallel", auth: "none" }),
        entry({ key: "parallel-authenticated", auth: "deployment-bearer" }),
        entry({ key: "google-drive" }),
        entry({ key: "notion" }),
        entry({ key: "routines", auth: "builtin" }),
      ],
      servers: [
        server({ id: "google-drive", provenance: "first-party" }),
        server({
          id: "parallel",
          provenance: "first-party",
          offeredToAllBots: true,
        }),
      ],
    }),
  ).toEqual(["google-drive", "notion"]);
});
