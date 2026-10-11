import { IconArrowUpRight, IconChevronDown } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useState } from "react";
import { VariablesDialog } from "@/components/marketplace/variables-dialog";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { SettingsPage } from "@/components/settings/settings-page";
import {
  BrokeredAccountRow,
  useBrokeredAccount,
} from "@/components/plugins/brokered-account-row";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  connectAccountMutationOptions,
  disconnectBrokeredMutationOptions,
  uninstallPluginMutationOptions,
} from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  marketplaceQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One service, and whether a Bot may read it as you.
 *
 * Its own page rather than a switch on the list, because what a connector needs from a person is not
 * fixed. Drive needs one consent and nothing else; a vendor that scopes access per workspace, or per
 * folder, or asks which of several accounts to use, needs somewhere to ask. This is that somewhere,
 * before there is anything to put in it.
 *
 * NO ADMINISTRATOR STEP STANDS BEFORE CONNECT. The page used to withhold the button until an
 * administrator had added the server row, because that row was where the OAuth client lived. The
 * platform provides the client now and `/servers/:id/connect` adds the row itself, so a vendor the
 * catalogue lists is a vendor you can connect — and a vendor the platform has no client for yet
 * says so in the server's own words when pressed, rather than in a button that cannot be pressed.
 */
export const Route = createFileRoute(
  "/_authed/_app/settings/connected-accounts/$key",
)({ component: RouteComponent });

function RouteComponent() {
  const { key } = useParams({
    from: "/_authed/_app/settings/connected-accounts/$key",
  });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const marketplace = useQuery(marketplaceQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const [notice, setNotice] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState(false);
  /*
   * Ending a held connection: the grant or the token in this deployment's own vault, revoked
   * here. The vendor is not asked, and the sentence beside the button says so.
   */
  const disconnect = useMutation({
    ...disconnectBrokeredMutationOptions(queryClient),
    onError: (thrown: Error) => setNotice(thrown.message),
  });
  const uninstall = useMutation({
    ...uninstallPluginMutationOptions(queryClient),
    onError: (thrown: Error) => setNotice(thrown.message),
    onSuccess: () => navigate({ to: "/settings/connected-accounts" }),
  });

  const connect = useMutation({
    ...connectAccountMutationOptions(),
    onError: (thrown: Error) => setNotice(thrown.message),
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be shown
     * to you in your own browser; there is deliberately nothing here that could complete it for you.
     */
    onSuccess: (authorizationUrl) => {
      /*
       * A 200 with no url on it is not a url to follow. Every press that reaches here is on a
       * `user-oauth` catalogue entry, whose half of that route always mints one or refuses — so
       * this is the server having answered something this page does not understand, and saying so
       * is the only honest thing left. Assigning it navigated to a page called `undefined` on this
       * deployment's own origin. See `connectAccountMutationOptions`.
       */
      if (authorizationUrl === null) {
        setNotice(
          "This deployment answered without a consent link, so there was nowhere to send you and nothing was connected. Try again, and tell an administrator if it persists.",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });

  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const server = (plugins.data?.servers ?? []).find((s) => s.id === key);
  const connection = (connections.data?.connections ?? []).find(
    (row) => row.serverId === key,
  );
  /*
   * Asked of the row rather than the catalogue, because a brokered app has no catalogue entry at
   * all: the deployment recorded how it is reached when the app was enabled, and that record is the
   * only thing here that knows.
   */
  const brokered = server?.provenance === "composio";

  /* Everything the brokered row below reads and does. See `brokered-account-row.tsx`. */
  const brokeredAccount = useBrokeredAccount({
    authScheme: server?.authScheme ?? null,
    brokered,
    configured: plugins.data?.composioConfigured ?? false,
    recorded: connection !== undefined,
    report: setNotice,
    returnTo: "settings",
    serverId: key,
    /*
     * Off the same row `recorded` is read from, and absent where you have never connected this app:
     * with no row there is nothing that could have been checked, which is what the server's own
     * columns default to. The three are optional on the type because that endpoint concatenates two
     * reads and only a brokered row carries them.
     */
    verified: connection?.verified ?? false,
    verifiedAt: connection?.verifiedAt ?? null,
    /*
     * PASSED THROUGH UNFLATTENED, unlike the two above. Their fallbacks are the server's own column
     * defaults, so an absent field and a recorded one mean the same thing; this one's null is the
     * server saying the last check of this key spent nothing, which is a different fact from having
     * been told nothing. Collapsing the two would hand the row a verdict on every page load that
     * has no record behind it.
     */
    probe: connection?.probe,
    /*
     * AND THIS ONE IS FLATTENED AGAIN, because it is a gate and not a verdict. `probe` is the
     * record of what the last check spent and this is whether the app has anything to check with
     * today — two questions, which is why they are two fields: gating the Re-check button on the
     * record left a key nothing was ever spent on unable to ever have anything spent on it. A
     * missing gate and a closed gate are the same gate, so absent collapses to false here where a
     * missing verdict above may not collapse to a null one.
     */
    checkable: connection?.checkable ?? false,
  });

  /*
   * BOTH READS ARE WAITED FOR, BECAUSE EVERY FACT THE BROKERED ROW BELOW DRAWS COMES FROM THE SECOND
   * ONE. `recorded`, `verified`, `verifiedAt`, `probe` and `checkable` are all off `connection`,
   * and this gated on `plugins` alone — so a connections read still in flight drew the row with the
   * whole of its state defaulted to "you have never connected this".
   */
  if (plugins.isPending || connections.isPending) {
    return <SettingsPage title="Account">{null}</SettingsPage>;
  }

  const back = {
    label: "Connected accounts",
    linkProps: { to: "/settings/connected-accounts" as const },
  };

  /*
   * AND A CONNECTIONS READ THAT FAILED IS SAID RATHER THAN DEFAULTED, WHICH IS WHAT THIS PAGE DID
   * WITH IT.
   *
   * Nothing read `connections.error`, so a 500 from `/api/plugins/connections` left `connection`
   * undefined and the row was handed `recorded: false, verified: false, probe: undefined,
   * checkable: false` — a connection nobody has made. For a brokered key app whose last check did
   * not come back clean, that is the exact state this whole feature exists to keep visible: the page
   * dropped the sentence, hid Disconnect AND Re-check, and drew Connect instead. Pressing it opens
   * the form and the route refuses the submission — "you already have an account, disconnect it
   * first" — so the only two controls that could end the state are the two the page just withdrew,
   * and no error text appears anywhere, because `connect.onError` is this route's only error branch.
   *
   * SAID BEFORE THE ROW RATHER THAN INSTEAD OF IT, and the row is not drawn at all: a row whose
   * entire content is connection state has nothing honest to say when that state could not be read.
   */
  if (connections.error) {
    return (
      <SettingsPage backButton={back} title={server?.title ?? key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          Whether you have connected this account could not be loaded, so
          nothing about it is shown here rather than something that may be
          wrong. Reload the page, and tell an administrator if it persists.
        </p>
      </SettingsPage>
    );
  }

  /*
   * The same for the plugin list. Every branch below decides what this connector is from it, and
   * without it they concluded there is none: "This is not a service you connect for yourself",
   * about a connector this person may hold right now.
   */
  if (!plugins.data) {
    return (
      <SettingsPage backButton={back} title={key}>
        <p className="mt-12 text-destructive text-sm" role="alert">
          This connector could not be loaded, so nothing about it is shown here
          rather than something that may be wrong. Reload the page, and tell an
          administrator if it persists.
        </p>
      </SettingsPage>
    );
  }

  /*
   * A brokered app, before the catalogue is consulted at all.
   *
   * It has no catalogue entry, so the branch below would find no `entry`, decide the deployment has
   * no connector by that name, and say so under the raw id — about the one connector the list on the
   * way in demonstrably drew a row for. Falling through to the `user-oauth` branch instead is no
   * better: its title and summary are the catalogue's, and there is none.
   */
  if (brokered && server) {
    /* Bound once because the row below is told it twice — once inside the whole disconnected
       sentence and once on its own — and two copies of it would drift. */
    const reassurance = "No Bot can read this as you.";

    return (
      <SettingsPage
        backButton={back}
        description="Reached through Composio, which holds the account, so a Bot sees only what you can see."
        title={server.title}
      >
        {notice ? (
          <p className="text-destructive text-sm" role="alert">
            {notice}
          </p>
        ) : null}

        {/* One decision, so no heading: it would only repeat the row's own title. */}
        <PageSection>
          <PageRows className="mt-0">
            <BrokeredAccountRow
              account={brokeredAccount}
              /* Said beside the button rather than after it: disconnecting ends the account at
                 Composio, so what it undoes is not the row here but the grant on your own mailbox,
                 and connecting again is a fresh consent. */
              connectedDescription={`A Bot granted its tools reads your ${server.title} as you. Disconnecting ends the account at Composio, not just here.`}
              disconnectedDescription={`${reassurance} Connecting takes you to Composio and then to the vendor to consent.`}
              /* What is true either way. The trip to Composio is not — an app whose key somebody
                 types never leaves this page — but which Bots can read this person's mail is the
                 whole point of the screen and holds for both kinds. */
              disconnectedReassurance={reassurance}
              title={server.title}
            />
          </PageRows>
        </PageSection>
      </SettingsPage>
    );
  }

  /*
   * A MARKETPLACE PLUGIN'S SERVER, reached the way its row says: an OAuth sign-in like a
   * catalogue vendor's, a token the person pastes, or nothing at all. The plugin it belongs to is
   * named, with who installed it, and removed whole from here — by that person or an administrator.
   */
  if (server?.provenance === "plugin") {
    const plugin = server.pluginId
      ? marketplace.data?.installed[server.pluginId]
      : undefined;
    const mayRemove =
      plugin !== undefined && (plugin.mine || me.data?.role === "admin");
    const removal = plugin ? (
      <PageSection
        description={`Removing ${plugin.name} takes every server and skill it installed away from every Bot, and ends every account connected to them.`}
        title="Plugin"
      >
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Part of {plugin.name}</ItemTitle>
              <ItemDescription>
                Added by {plugin.installedBy ?? "somebody"}
                {plugin.mine ? " (you)" : ""}.
              </ItemDescription>
            </ItemContent>
            {mayRemove ? (
              <ItemActions>
                <Button
                  disabled={uninstall.isPending}
                  onClick={() => {
                    setNotice(null);
                    uninstall.mutate(plugin.id);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {uninstall.isPending ? "Removing…" : "Remove plugin"}
                </Button>
              </ItemActions>
            ) : null}
          </Item>
        </PageRows>
      </PageSection>
    ) : null;

    if (server.authKind === "none") {
      return (
        <SettingsPage
          backButton={back}
          description="This is not a service you connect for yourself."
          title={server.title}
        >
          <PageEmpty>
            There is no account to connect. It is available to every Bot
            already.
          </PageEmpty>
          {removal}
        </SettingsPage>
      );
    }

    const header = server.authKind === "header";
    return (
      <SettingsPage
        backButton={back}
        description={
          server.summary ||
          `Reached as you, from the ${plugin?.name ?? "plugin"} plugin.`
        }
        title={server.title}
      >
        {notice ? (
          <p className="text-destructive text-sm" role="alert">
            {notice}
          </p>
        ) : null}
        <PageSection>
          <PageRows className="mt-0">
            <Item size="sm">
              <ItemContent>
                <ItemTitle>{header ? "Your key" : "Your account"}</ItemTitle>
                <ItemDescription>
                  {connection
                    ? header
                      ? "Every Bot can use this with your key. Nobody else's calls carry it."
                      : "Every Bot can use this as you. It sees only what you can see."
                    : header
                      ? `No Bot can reach ${server.title} as you until you add your key.`
                      : "No Bot can read this as you. Connecting takes you to the vendor to consent."}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {connection ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button size="sm" type="button" variant="outline">
                          <span
                            aria-hidden="true"
                            className="size-1.5 rounded-full bg-emerald-500"
                          />
                          {header ? "Key added" : "Connected"}
                          <IconChevronDown />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end" className="w-auto">
                      {header ? (
                        <DropdownMenuItem
                          className="whitespace-nowrap"
                          onClick={() => setAddingKey(true)}
                        >
                          Replace your key
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        className="whitespace-nowrap"
                        onClick={() => {
                          setNotice(null);
                          disconnect.mutate(key);
                        }}
                        variant="destructive"
                      >
                        {header
                          ? "Remove your key"
                          : `Disconnect your ${server.title} account`}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : header ? (
                  <Button
                    onClick={() => {
                      setNotice(null);
                      setAddingKey(true);
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Add key
                  </Button>
                ) : (
                  <Button
                    disabled={connect.isPending}
                    onClick={() => {
                      setNotice(null);
                      connect.mutate(key);
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Connect
                    <IconArrowUpRight />
                  </Button>
                )}
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
        {removal}
        {header ? (
          <VariablesDialog
            onClose={() => setAddingKey(false)}
            onConnected={() => setAddingKey(false)}
            open={addingKey}
            serverId={key}
            title={server.title}
            variables={server.connectVariables ?? []}
          />
        ) : null}
      </SettingsPage>
    );
  }

  /*
   * A vendor that is not reached as a person has nothing here for anybody to decide. It says which
   * kind it is rather than drawing a button that cannot work: an app with no account to hold is
   * enabled from the Marketplace, for everybody, and a vendor with a shared token is the
   * administrator's.
   */
  if (entry?.auth !== "user-oauth") {
    return (
      <SettingsPage
        backButton={back}
        description="This is not a service you connect for yourself."
        title={entry?.title ?? key}
      >
        <PageEmpty>
          {entry?.auth === "none" || entry?.auth === "builtin"
            ? "There is no account to connect. Enable it from the Marketplace and every Bot can use it."
            : entry
              ? "A Bot reaches this one with a credential the deployment holds, the same for everybody."
              : "This deployment has no connector by that name."}
        </PageEmpty>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      backButton={back}
      description={entry.summary}
      title={entry.title}
    >
      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      {/* One decision, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows className="mt-0">
          <Item size="sm">
            <ItemContent>
              {/* Not "Connect your account": the row is also the connected state, and a title has to
                  read for both. */}
              <ItemTitle>Your account</ItemTitle>
              <ItemDescription>
                {connection
                  ? "Every Bot can use this as you. It sees only what you can see."
                  : "No Bot can read this as you. Connecting takes you to the vendor to consent."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {connection ? (
                /*
                 * A state and a menu, not a switch. Connected is a fact about a grant that lives at
                 * the vendor, and withdrawing it is a deliberate act rather than the other half of a
                 * position — so it is named in a menu instead of being whatever happens when
                 * something slides back.
                 */
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button size="sm" type="button" variant="outline">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-500"
                        />
                        Connected
                        <IconChevronDown />
                      </Button>
                    }
                  />
                  {/*
                   * `w-auto`, because the default is `w-(--anchor-width)` — the width of the trigger,
                   * which here is a small "Connected" button. Left alone, the one item inside wraps
                   * onto three lines and a destructive action becomes hard to read at the moment it
                   * most needs to be legible.
                   */}
                  <DropdownMenuContent align="end" className="w-auto">
                    <DropdownMenuItem
                      onClick={() => {
                        /*
                         * The grant in this deployment's vault is revoked and the row deleted;
                         * the vendor is not asked, so the grant it holds outlives this until it
                         * is revoked there too. Said in the notice rather than implied.
                         */
                        setNotice(null);
                        disconnect.mutate(key, {
                          onSuccess: () =>
                            setNotice(
                              `Disconnected here. ${entry.vendor} still lists this deployment under your account's third-party access until you revoke it there.`,
                            ),
                        });
                      }}
                      className="whitespace-nowrap"
                      variant="destructive"
                    >
                      Disconnect your {entry.title} account
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                /*
                 * The arrow says this leaves OpenBot. It does: the next thing on screen is the
                 * vendor's own consent page, and a control that navigates away should look like one.
                 *
                 * Disabled only while its own request is in flight. A vendor the platform has no
                 * client for is refused by the server with a sentence saying so, which lands in the
                 * notice above — a refusal somebody can read, where a button that would not press
                 * told them nothing.
                 */
                <Button
                  disabled={connect.isPending}
                  onClick={() => {
                    setNotice(null);
                    connect.mutate(key);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Connect
                  <IconArrowUpRight />
                </Button>
              )}
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {connection ? (
        <PageSection
          description="What you agreed to, as the vendor recorded it — not what was asked for. The two differ when a consent screen is only partly accepted."
          title="Access"
        >
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Granted</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {connection.scope || "The vendor named no scope."}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Connected</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {new Date(connection.connectedAt).toLocaleString()}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
    </SettingsPage>
  );
}
