import {
  IconArrowUpRight,
  IconChevronDown,
  IconExternalLink,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import { accountRows, personalKeyRows } from "@/components/keys/key-rows";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { VariablesDialog } from "@/components/marketplace/variables-dialog";
import { catalogueMarkFor } from "@/components/plugins/catalogue-marks";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { SettingsPage } from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
  createCredentialMutationOptions,
  revokeCredentialMutationOptions,
} from "@/lib/credentials/mutations";
import { credentialListQueryOptions } from "@/lib/credentials/queries";
import { useTranslation } from "@/lib/i18n";
import { useContentText } from "@/lib/i18n/content";
import { modelKeyKeys, modelKeyQueryOptions } from "@/lib/model-key/queries";
import {
  connectAccountMutationOptions,
  disconnectBrokeredMutationOptions,
} from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * Keys: every secret this deployment runs on, in one place — laid out like Hermes Agent's
 * dashboard Keys page. The model's key first, then the keys you paste for connectors, then the
 * accounts you sign in to, and for an administrator the deployment's own credentials.
 *
 * Nothing here is new machinery. The model key is the credential vault's `model` row, which the
 * runtime already resolves per call (see `server/src/model-key/routes.ts`); a connector key is
 * the Marketplace's Add key; an account is the Marketplace's Connect. The page gathers the three
 * so a person looking for "where do my keys live" has one answer.
 */
export const Route = createFileRoute("/_authed/_app/settings/keys")({
  component: RouteComponent,
});

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

function RouteComponent() {
  const { t } = useTranslation("settings");
  const content = useContentText();
  const queryClient = useQueryClient();
  const me = useQuery(currentUserQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const isAdmin = me.data?.role === "admin";
  const [notice, setNotice] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);

  const disconnect = useMutation({
    ...disconnectBrokeredMutationOptions(queryClient),
    onError: (thrown: Error) => setNotice(thrown.message),
  });
  const connect = useMutation({
    ...connectAccountMutationOptions("settings"),
    onError: (thrown: Error) => setNotice(thrown.message),
    onSuccess: (authorizationUrl) => {
      if (authorizationUrl === null) {
        setNotice(
          t(
            "This deployment answered without a consent link, so there was nowhere to send you and nothing was connected. Try again, and tell an administrator if it persists.",
          ),
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  const page = plugins.data ?? { catalogue: [], servers: [] };
  const keys = personalKeyRows(page);
  const accounts = accountRows(page);
  const keyRow = keys.find((row) => row.key === keyFor);

  return (
    <SettingsPage
      className="max-w-4xl"
      description={t(
        "The model your Bots run on, the keys you have added, and the accounts you have connected.",
      )}
      title={t("Keys")}
    >
      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      <ModelSection isAdmin={isAdmin} onNotice={setNotice} />

      {/*
       * Both reads decide the two lists below, for the reason `connected-accounts/index.tsx` gives:
       * a plugins read that succeeded beside a connections read that failed would draw every key
       * as not added. One sentence for both.
       */}
      {plugins.isPending || connections.isPending ? null : plugins.error ||
        connections.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          {t(
            "Your keys and accounts could not be loaded, so nothing is listed here rather than a list that may be wrong. Reload the page, and tell an administrator if it persists.",
          )}
        </p>
      ) : (
        <>
          <PageSection
            description={t(
              "Keys you paste for a connector. Every Bot uses a connector with your key; nobody else's calls carry it.",
            )}
            title={t("Your API keys")}
          >
            {keys.length === 0 ? (
              <PageEmpty>
                {t(
                  "No connector takes a key yet. Add one from the Marketplace — a plugin whose connector wants a token lists it here.",
                )}
              </PageEmpty>
            ) : (
              <PageRows>
                {keys.map((row, index) => (
                  <React.Fragment key={row.key}>
                    <Item size="sm">
                      <RowMark>
                        {row.logo ? (
                          <PluginLogo logo={row.logo} />
                        ) : (
                          (() => {
                            const Mark = catalogueMarkFor(row.key);
                            return <Mark className="size-4" />;
                          })()
                        )}
                      </RowMark>
                      <ItemContent>
                        <ItemTitle>{row.title}</ItemTitle>
                        <ItemDescription>
                          {connected.has(row.key)
                            ? t(
                                "Key added. Every Bot can use this with your key.",
                              )
                            : content(row.summary)}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {row.kind === "brokered-key" ? (
                          <Link
                            className="text-sm underline-offset-4 hover:underline"
                            params={{ key: row.key }}
                            to="/settings/connected-accounts/$key"
                          >
                            {t("Manage")}
                          </Link>
                        ) : connected.has(row.key) ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  size="sm"
                                  type="button"
                                  variant="outline"
                                >
                                  <span
                                    aria-hidden="true"
                                    className="size-1.5 rounded-full bg-emerald-500"
                                  />
                                  {t("Key added")}
                                  <IconChevronDown />
                                </Button>
                              }
                            />
                            <DropdownMenuContent align="end" className="w-auto">
                              <DropdownMenuItem
                                className="whitespace-nowrap"
                                onClick={() => setKeyFor(row.key)}
                              >
                                {t("Replace your key")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="whitespace-nowrap"
                                onClick={() => {
                                  setNotice(null);
                                  disconnect.mutate(row.key);
                                }}
                                variant="destructive"
                              >
                                {t("Remove your key")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <Button
                            aria-label={t("Add key for {{title}}", {
                              title: row.title,
                            })}
                            onClick={() => {
                              setNotice(null);
                              setKeyFor(row.key);
                            }}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            {t("Add key")}
                          </Button>
                        )}
                      </ItemActions>
                    </Item>
                    {index !== keys.length - 1 && <Separator />}
                  </React.Fragment>
                ))}
              </PageRows>
            )}
          </PageSection>

          <PageSection
            description={t(
              "Accounts you sign in to at the vendor. A Bot using one sees only what you can see.",
            )}
            title={t("Connected accounts")}
          >
            {accounts.length === 0 ? (
              <PageEmpty>
                {t(
                  "Nothing to connect yet. These appear as soon as this deployment's catalogue lists a service that reads as the person asking.",
                )}
              </PageEmpty>
            ) : (
              <PageRows>
                {accounts.map((app, index) => {
                  const Mark = catalogueMarkFor(app.key);
                  const isConnected = connected.has(app.key);
                  return (
                    <React.Fragment key={app.key}>
                      <Item size="sm">
                        <RowMark>
                          {app.logo ? (
                            <PluginLogo logo={app.logo} />
                          ) : (
                            <Mark className="size-4" />
                          )}
                        </RowMark>
                        <ItemContent>
                          <ItemTitle>
                            <Link
                              className="underline-offset-4 hover:underline"
                              params={{ key: app.key }}
                              to="/settings/connected-accounts/$key"
                            >
                              {app.title}
                            </Link>
                          </ItemTitle>
                          <ItemDescription>
                            {isConnected
                              ? t("Connected. Every Bot can use this as you.")
                              : content(app.summary)}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          {isConnected ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <Button
                                    size="sm"
                                    type="button"
                                    variant="outline"
                                  >
                                    <span
                                      aria-hidden="true"
                                      className="size-1.5 rounded-full bg-emerald-500"
                                    />
                                    {t("Connected")}
                                    <IconChevronDown />
                                  </Button>
                                }
                              />
                              <DropdownMenuContent
                                align="end"
                                className="w-auto"
                              >
                                <DropdownMenuItem
                                  className="whitespace-nowrap"
                                  onClick={() => {
                                    setNotice(null);
                                    disconnect.mutate(app.key);
                                  }}
                                  variant="destructive"
                                >
                                  {`Disconnect your ${app.title} account`}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            <Button
                              aria-label={t("Connect {{title}}", {
                                title: app.title,
                              })}
                              disabled={connect.isPending}
                              onClick={() => {
                                setNotice(null);
                                connect.mutate(app.key);
                              }}
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              {t("Connect")}
                              <IconArrowUpRight />
                            </Button>
                          )}
                        </ItemActions>
                      </Item>
                      {index !== accounts.length - 1 && <Separator />}
                    </React.Fragment>
                  );
                })}
              </PageRows>
            )}
          </PageSection>
        </>
      )}

      {isAdmin ? <DeploymentCredentials /> : null}

      {keyRow ? (
        <VariablesDialog
          onClose={() => setKeyFor(null)}
          onConnected={() => setKeyFor(null)}
          open
          serverId={keyRow.key}
          title={keyRow.title}
          variables={keyRow.variables}
        />
      ) : null}
    </SettingsPage>
  );
}

/**
 * The model's key. Metered: the platform's gateway, and the billing page is where that is
 * managed. Bring-your-own: where the key in force comes from, and for an administrator a way to
 * replace it in place — the vault row the runtime reads before the environment on every call —
 * and to fall back to the deployment's own again.
 */
function ModelSection({
  isAdmin,
  onNotice,
}: {
  isAdmin: boolean;
  onNotice: (message: string | null) => void;
}) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const modelKey = useQuery(modelKeyQueryOptions());
  const [isReplacing, setIsReplacing] = useState(false);
  const [plaintext, setPlaintext] = useState("");
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: modelKeyKeys.all });
  const replace = useMutation({
    ...createCredentialMutationOptions(queryClient),
    onError: (thrown: Error) => onNotice(thrown.message),
    onSuccess: async () => {
      onNotice(null);
      setPlaintext("");
      setIsReplacing(false);
      await refresh();
    },
  });
  const revoke = useMutation({
    ...revokeCredentialMutationOptions(queryClient),
    onError: (thrown: Error) => onNotice(thrown.message),
    onSuccess: async () => {
      onNotice(null);
      await refresh();
    },
  });

  const data = modelKey.data;
  const providerLabel = data
    ? (PROVIDER_LABEL[data.provider] ?? data.provider)
    : "";

  return (
    <PageSection
      className="mt-0"
      description={t("The provider and model every Bot answers with.")}
      title={t("Model")}
    >
      {modelKey.isPending ? null : !data ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {t("The model key could not be loaded.")}
        </p>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>
                {providerLabel} · {data.model}
              </ItemTitle>
              <ItemDescription>
                {data.metered
                  ? t(
                      "Runs on the HyperNoesis API. Usage is metered on your plan.",
                    )
                  : data.source === "vault"
                    ? t("Runs on a key stored here, replaced from this page.")
                    : data.source === "environment"
                      ? t("Runs on the key this deployment was set up with.")
                      : data.source === "none"
                        ? t("No key is set. Bots cannot answer until one is.")
                        : t("Runs on this deployment's own key.")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {data.metered ? (
                data.billingUrl ? (
                  <Button
                    render={
                      <a
                        href={data.billingUrl}
                        rel="noreferrer"
                        target="_blank"
                      />
                    }
                    size="sm"
                    variant="outline"
                  >
                    {t("Plan and usage")}
                    <IconExternalLink />
                  </Button>
                ) : null
              ) : isAdmin ? (
                <div className="flex items-center gap-2">
                  {data.source === "vault" && data.credentialId ? (
                    <Button
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(data.credentialId as string)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("Use the deployment's key again")}
                    </Button>
                  ) : null}
                  <Button
                    onClick={() => setIsReplacing(true)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {data.source === "none" ? t("Add key") : t("Replace key")}
                  </Button>
                </div>
              ) : null}
            </ItemActions>
          </Item>
        </PageRows>
      )}

      {data && isAdmin ? (
        <Dialog onOpenChange={setIsReplacing} open={isReplacing}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t("Replace the {{providerLabel}} key", { providerLabel })}
              </DialogTitle>
              <DialogDescription>
                {t(
                  "Stored encrypted here and used from the next call on. The key it replaces is retired in the same step; the deployment's own key stays as the fallback.",
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="model-key-plaintext">
                    {t("{{providerLabel}} API key", { providerLabel })}
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    id="model-key-plaintext"
                    onChange={(event) => setPlaintext(event.target.value)}
                    type="password"
                    value={plaintext}
                  />
                </Field>
              </FieldGroup>
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                onClick={() => setIsReplacing(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("Cancel")}
              </Button>
              <Button
                disabled={plaintext.trim() === "" || replace.isPending}
                onClick={() =>
                  replace.mutate({
                    kind: "model",
                    provider: data.provider,
                    keyId: data.keyId ?? "model-api-key",
                    metadata: {},
                    plaintext: plaintext.trim(),
                  })
                }
                size="sm"
                type="button"
              >
                {replace.isPending ? t("Saving…") : t("Save key")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </PageSection>
  );
}

/** For an administrator: how many deployment credentials are live, and where they are managed. */
function DeploymentCredentials() {
  const { t } = useTranslation("settings");
  const credentials = useQuery(credentialListQueryOptions());
  const live = (credentials.data ?? []).filter(
    (credential) => credential.revokedAt === null,
  ).length;
  return (
    <PageSection
      description={t(
        "Keys the deployment itself holds for vendors, kept by an administrator.",
      )}
      title={t("Deployment credentials")}
    >
      <PageRows>
        <Item size="sm">
          <ItemContent>
            <ItemTitle>
              {credentials.isPending
                ? t("Loading…")
                : t("{{count}} live credentials", {
                    count: live,
                    defaultValue_one: "{{count}} live credential",
                  })}
            </ItemTitle>
            <ItemDescription>
              {t(
                "Added, rotated and revoked on the Credentials screen in Admin.",
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Link
              className="text-sm underline-offset-4 hover:underline"
              to="/admin/credentials"
            >
              {t("Open Credentials")}
            </Link>
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
