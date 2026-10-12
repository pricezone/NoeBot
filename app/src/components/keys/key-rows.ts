import {
  type ConnectableApp,
  connectableAccounts,
} from "@/components/plugins/connectable-apps";
import type { ConnectVariable, PluginsPage } from "@/lib/plugins/queries";

/**
 * What the Keys page lists, decided without a DOM.
 *
 * Two lists, by what the person hands over: a KEY they paste — a Marketplace plugin's `header`
 * server, or a brokered app Composio reaches with an API key — and an ACCOUNT they sign in to,
 * which is everything `connectableAccounts` lists that is not one of the former. The split is
 * Hermes' dashboard's: keys on one card, logins on another.
 */
export type KeyRow = {
  key: string;
  title: string;
  summary: string;
  logo: string | null;
  /** `header`: a key this deployment stores and sends itself. `brokered-key`: Composio holds it. */
  kind: "header" | "brokered-key";
  /** What the Add key form asks for; empty for a brokered app, whose form is Composio's. */
  variables: ConnectVariable[];
};

export function personalKeyRows(page: Pick<PluginsPage, "servers">): KeyRow[] {
  return page.servers.flatMap((server): KeyRow[] => {
    if (server.provenance === "plugin" && server.authKind === "header") {
      return [
        {
          key: server.id,
          title: server.title,
          summary: server.summary,
          logo: server.logo ?? null,
          kind: "header",
          variables: server.connectVariables ?? [],
        },
      ];
    }
    if (server.provenance === "composio" && server.authScheme === "API_KEY") {
      return [
        {
          key: server.id,
          title: server.title,
          summary: server.summary,
          logo: server.logo ?? null,
          kind: "brokered-key",
          variables: [],
        },
      ];
    }
    return [];
  });
}

/** The accounts a person signs in to: every connectable account that is not a key. */
export function accountRows(
  page: Pick<PluginsPage, "catalogue" | "servers">,
): ConnectableApp[] {
  const keys = new Set(personalKeyRows(page).map((row) => row.key));
  return connectableAccounts(page).filter((app) => !keys.has(app.key));
}
