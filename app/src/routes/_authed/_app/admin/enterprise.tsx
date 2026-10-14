import {
  IconChartBar,
  IconChevronRight,
  IconDeviceDesktop,
  IconFingerprint,
  IconKey,
  IconNetwork,
  IconPlug,
  IconShieldLock,
  IconTerminal2,
  IconToggleRight,
  IconUsersGroup,
  IconWorld,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  removeNetworkPolicyMutationOptions,
  setCapabilityMutationOptions,
  setEnterpriseSettingMutationOptions,
  setNetworkPolicyMutationOptions,
  terminateInactiveComputersMutationOptions,
} from "@/lib/enterprise/mutations";
import {
  actionRecordsQueryOptions,
  type CapabilitySetting,
  type EgressRule,
  type EnterpriseOverview,
  enterpriseOverviewQueryOptions,
  modelUsageQueryOptions,
  type NetworkMode,
  type NetworkPolicy,
} from "@/lib/enterprise/queries";
import { i18n, msg, useTranslation } from "@/lib/i18n";
import { useContentText } from "@/lib/i18n/content";
import { intlLocale } from "@/lib/i18n/format";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/_app/admin/enterprise")({
  component: EnterprisePage,
});

const MODE_NAMES: Record<NetworkMode, string> = {
  allow_all: msg("Allow all network access"),
  defaults_plus_allowlist: msg("Defaults plus team allowlist"),
  allowlist_only: msg("Team allowlist only"),
};

/** One rule per line: `example.com`, `*.corp.example`, or `10.0.0.0/8 443,8443`. */
function rulesFromText(text: string): EgressRule[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value = "", ports] = line.split(/\s+/, 2);
      return /^[\d.:a-fA-F]+(\/\d+)?$/.test(value) &&
        /[\d]/.test(value) &&
        /[.:]/.test(value)
        ? { type: "cidr" as const, value, ...(ports ? { ports } : {}) }
        : { type: "domain" as const, value };
    });
}

function rulesToText(rules: EgressRule[]): string {
  return rules
    .map((rule) =>
      rule.type === "domain"
        ? rule.value
        : `${rule.value}${rule.ports ? ` ${rule.ports}` : ""}`,
    )
    .join("\n");
}

function summarizePolicy(policy: NetworkPolicy | undefined): string {
  if (!policy)
    return i18n.t(
      "No policy: Bot computers may reach anything the cluster allows",
    );
  const count = policy.rules.length;
  return `${i18n.t(MODE_NAMES[policy.mode])} · ${i18n.t("{{count}} rules", {
    count,
    defaultValue_one: "{{count}} rule",
  })}${policy.locked ? i18n.t(" · locked") : ""}`;
}

function EnterprisePage() {
  const { t } = useTranslation("admin");
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const setSetting = useMutation(
    setEnterpriseSettingMutationOptions(queryClient),
  );
  const failure = setCapability.error ?? setSetting.error;

  return (
    <PageShell
      description={t(
        "What members may use, how Bot computers reach the network, and what is recorded about it. Every change is on the audit trail.",
      )}
      title={t("Enterprise controls")}
    >
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
      {overview.isPending ? null : overview.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {t("Could not load enterprise controls.")}
        </p>
      ) : (
        <EnterpriseSections
          data={overview.data}
          onCapability={(capability, allowed) =>
            setCapability.mutate({
              scopeKind: "organization",
              scopeId: "",
              capability,
              allowed,
            })
          }
          onSetting={(key, value) => setSetting.mutate({ key, value })}
          saving={setCapability.isPending || setSetting.isPending}
        />
      )}
    </PageShell>
  );
}

function EnterpriseSections({
  data,
  onCapability,
  onSetting,
  saving,
}: {
  data: EnterpriseOverview;
  onCapability: (
    capability: CapabilitySetting["capability"],
    allowed: boolean,
  ) => void;
  onSetting: (
    key: keyof EnterpriseOverview["settings"],
    value: unknown,
  ) => void;
  saving: boolean;
}) {
  const { t } = useTranslation("admin");
  // A capability's words come from the server, which keeps them in English (server namespace).
  const { t: said } = useTranslation("server");
  const content = useContentText();
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [networkScope, setNetworkScope] = useState<
    { scopeKind: "organization" | "group"; scopeId: string } | undefined
  >();
  const [modelsOpen, setModelsOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const { settings } = data;
  const overrideCount = data.capabilities.reduce(
    (count, capability) =>
      count +
      Object.keys(capability.roles).length +
      Object.keys(capability.groups).length,
    0,
  );
  const organizationPolicy = data.network.find(
    (row) => row.scopeKind === "organization",
  );
  const groupPolicies = data.network.filter((row) => row.scopeKind === "group");

  return (
    <>
      <PageSection
        description={t(
          "Social sign-in stays available to addresses in INITIAL_ADMIN_EMAILS as a break-glass way in, and every such sign-in is audited.",
        )}
        title={t("Sign-in")}
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("Require SSO")}</ItemTitle>
              <ItemDescription>
                {settings.ssoRequired
                  ? t(
                      "Only a registered SAML or OpenID Connect provider may sign anybody in.",
                    )
                  : t(
                      "People may also sign in with Google, Microsoft or Okta.",
                    )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("Require SSO")}
                checked={settings.ssoRequired}
                disabled={saving}
                onCheckedChange={(checked) => onSetting("ssoRequired", checked)}
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconFingerprint />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("SCIM provisioning")}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {data.scim.configured
                  ? t(
                      "Directory base URL {{baseUrl}} with the SCIM_BEARER_TOKEN bearer token. Deprovisioning ends sessions, deny-lists the address, retires connector credentials and stops their computers.",
                      { baseUrl: data.scim.baseUrl ?? "(set BETTER_AUTH_URL)" },
                    )
                  : t(
                      "Off. Set SCIM_BEARER_TOKEN to accept provisioning from Okta, Entra or another directory.",
                    )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.scim.configured ? t("On") : t("Off")}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description={t(
          "The switch is the whole organization. Roles can be given a different answer, and a directory group can be granted a capability the organization has off.",
        )}
        title={t("Capabilities")}
      >
        <PageRows>
          {data.capabilities.map((capability) => {
            const effective = capability.organization ?? capability.default;
            return (
              <div key={capability.capability}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconToggleRight />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{said(capability.title)}</ItemTitle>
                    <ItemDescription>
                      {effective
                        ? said(capability.description)
                        : t("Nobody may, unless a role or group grants it.")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={said(capability.title)}
                      checked={effective}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        onCapability(capability.capability, checked)
                      }
                    />
                  </ItemActions>
                </Item>
                <Separator />
              </div>
            );
          })}
          <Item
            render={
              <button onClick={() => setOverridesOpen(true)} type="button" />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconUsersGroup />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("Role and group overrides")}</ItemTitle>
              <ItemDescription>
                {overrideCount === 0
                  ? t("None: everybody gets the switches above")
                  : t("{{overrideCount}} set", { overrideCount })}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description={t(
          "Where Bot computers may connect. Applied to running computers within seconds, without a restart. A group policy replaces the organization's unless it is locked.",
        )}
        title={t("Network")}
      >
        <PageRows>
          <Item
            render={
              <button
                onClick={() =>
                  setNetworkScope({ scopeKind: "organization", scopeId: "" })
                }
                type="button"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconWorld />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("Organization")}</ItemTitle>
              <ItemDescription>
                {summarizePolicy(organizationPolicy)}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          {groupPolicies.map((policy) => (
            <div key={policy.scopeId}>
              <Separator />
              <Item
                render={
                  <button
                    onClick={() =>
                      setNetworkScope({
                        scopeKind: "group",
                        scopeId: policy.scopeId,
                      })
                    }
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconNetwork />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {t("Group: {{scopeId}}", { scopeId: policy.scopeId })}
                  </ItemTitle>
                  <ItemDescription>{summarizePolicy(policy)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </div>
          ))}
        </PageRows>
        {data.groups.length > 0 ? (
          <Button
            className="mt-4"
            onClick={() => setNetworkScope({ scopeKind: "group", scopeId: "" })}
            size="sm"
            variant="outline"
          >
            {t("Add a group policy")}
          </Button>
        ) : null}
      </PageSection>

      <PageSection
        description={t(
          "With the allowlist on, a Bot may call tools only on the MCP servers approved here. Every other server's calls are refused.",
        )}
        title={t("MCP servers")}
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconPlug />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("Only approved servers")}</ItemTitle>
              <ItemDescription>
                {settings.mcpAllowlist.enabled
                  ? t("{{length}} approved", {
                      length: settings.mcpAllowlist.servers.length,
                    })
                  : t(
                      "Off: every registered server may be used as its grants allow.",
                    )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("Only approved MCP servers")}
                checked={settings.mcpAllowlist.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  onSetting("mcpAllowlist", {
                    ...settings.mcpAllowlist,
                    enabled,
                  })
                }
              />
            </ItemActions>
          </Item>
          {data.mcpServers.map((server) => {
            const approved = settings.mcpAllowlist.servers.includes(server.id);
            return (
              <div key={server.id}>
                <Separator />
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{content(server.title)}</ItemTitle>
                    <ItemDescription>{server.url}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={t("Approve {{title}}", {
                        title: content(server.title),
                      })}
                      checked={approved}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        onSetting("mcpAllowlist", {
                          ...settings.mcpAllowlist,
                          servers: checked
                            ? [...settings.mcpAllowlist.servers, server.id]
                            : settings.mcpAllowlist.servers.filter(
                                (id) => id !== server.id,
                              ),
                        })
                      }
                    />
                  </ItemActions>
                </Item>
              </div>
            );
          })}
        </PageRows>
      </PageSection>

      <PageSection
        description={t(
          "The built-in Bot runs on {{builtInModel}}. A remote Bot chooses its own; the model its stream names is recorded.",
          {
            builtInModel:
              data.builtInModel ?? "the deployment's configured model",
          },
        )}
        title={t("Models")}
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("Model allowlist")}</ItemTitle>
              <ItemDescription>
                {settings.modelAllowlist.enabled
                  ? t(
                      "A built-in Bot on a model not listed is refused before it runs.",
                    )
                  : t("Off: any model may serve a run.")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("Model allowlist")}
                checked={settings.modelAllowlist.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  onSetting("modelAllowlist", {
                    ...settings.modelAllowlist,
                    enabled,
                  })
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={
              <button onClick={() => setModelsOpen(true)} type="button" />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconKey />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("Allowed models")}</ItemTitle>
              <ItemDescription>
                {settings.modelAllowlist.models.length === 0
                  ? t("None listed")
                  : settings.modelAllowlist.models.join(", ")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
        <ModelUsage />
      </PageSection>

      <PageSection
        description={t(
          "Audit events and Bot actions stream to your OpenTelemetry collector or SIEM when OTEL_EXPORTER_OTLP_ENDPOINT is set, tagged openbot.surface.",
        )}
        title={t("Recording and export")}
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconTerminal2 />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("Action Recording")}</ItemTitle>
              <ItemDescription>
                {settings.actionRecording
                  ? t(
                      "Shell commands Bots run are recorded with secrets scrubbed and kept {{actionRecordRetentionDays}} days.",
                      {
                        actionRecordRetentionDays:
                          data.actionRecordRetentionDays,
                      },
                    )
                  : t("Off: commands are on the audit trail only.")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("Action Recording")}
                checked={settings.actionRecording}
                disabled={saving}
                onCheckedChange={(checked) =>
                  onSetting("actionRecording", checked)
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconChartBar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("OpenTelemetry export")}</ItemTitle>
              <ItemDescription>
                {data.otel.configured
                  ? t("Exporting over OTLP/HTTP.")
                  : t(
                      "Not configured. Set OTEL_EXPORTER_OTLP_ENDPOINT on the server.",
                    )}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.otel.configured ? t("On") : t("Off")}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
        {settings.actionRecording ? <RecordedActions /> : null}
      </PageSection>

      <PageSection
        description={t(
          "Stopping a computer ends its running Bots and keeps its disk. The Bot gets a fresh computer next session. Stop one person's from People.",
        )}
        title={t("Computers")}
      >
        <PageRows>
          <Item
            render={<button onClick={() => setDaysOpen(true)} type="button" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconDeviceDesktop />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("Stop inactive computers")}</ItemTitle>
              <ItemDescription>
                {settings.inactiveComputerDays === 0
                  ? t("Off")
                  : t("After {{inactiveComputerDays}} days without use", {
                      inactiveComputerDays: settings.inactiveComputerDays,
                    })}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
        <SweepNow />
      </PageSection>

      <OverridesDialog
        data={data}
        onOpenChange={setOverridesOpen}
        open={overridesOpen}
      />
      {networkScope ? (
        <NetworkDialog
          data={data}
          initial={networkScope}
          onClose={() => setNetworkScope(undefined)}
        />
      ) : null}
      <ListDialog
        description={t(
          "One model per line, as provider/model, for example openai/gpt-5.6-terra.",
        )}
        initial={settings.modelAllowlist.models}
        onClose={() => setModelsOpen(false)}
        onSave={(models) =>
          onSetting("modelAllowlist", { ...settings.modelAllowlist, models })
        }
        open={modelsOpen}
        title={t("Allowed models")}
      />
      <DaysDialog
        initial={settings.inactiveComputerDays}
        onClose={() => setDaysOpen(false)}
        onSave={(days) => onSetting("inactiveComputerDays", days)}
        open={daysOpen}
      />
    </>
  );
}

function ModelUsage() {
  const { t } = useTranslation("admin");
  const usage = useQuery(modelUsageQueryOptions(30));
  if (usage.isPending) return null;
  if (usage.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {t("Could not load model usage.")}
      </p>
    );
  if (usage.data.summary.length === 0)
    return (
      <PageEmpty>
        {t("No Bot runs have been recorded in the last 30 days.")}
      </PageEmpty>
    );
  return (
    <PageRows>
      {usage.data.summary.map((row, index) => (
        <div key={`${row.model}-${row.source}`}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconChartBar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{row.model}</ItemTitle>
              <ItemDescription>
                {t("{{runs}} runs by {{count}} people in 30 days", {
                  runs: row.runs,
                  count: row.people,
                  defaultValue_one:
                    "{{runs}} runs by {{count}} person in 30 days",
                })}
                {row.refused > 0
                  ? t(" · {{refused}} off the allowlist", {
                      refused: row.refused,
                    })
                  : ""}{" "}
                · {row.source}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {new Date(row.lastUsedAt).toLocaleDateString(intlLocale())}
              </span>
            </ItemActions>
          </Item>
        </div>
      ))}
    </PageRows>
  );
}

function RecordedActions() {
  const { t } = useTranslation("admin");
  const actions = useQuery(actionRecordsQueryOptions());
  if (actions.isPending) return null;
  if (actions.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {t("Could not load recorded actions.")}
      </p>
    );
  if (actions.data.length === 0)
    return <PageEmpty>{t("No commands recorded yet.")}</PageEmpty>;
  return (
    <PageRows>
      {actions.data.map((action, index) => (
        <div key={action.id}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            <ItemContent>
              <ItemTitle className="font-mono text-xs">
                {action.command}
              </ItemTitle>
              <ItemDescription>
                {action.surface === "local"
                  ? t("Member's machine")
                  : t("Bot {{botId}}", { botId: action.botId ?? "?" })}{" "}
                · {action.outcome} ·{" "}
                {new Date(action.createdAt).toLocaleString(intlLocale())}
              </ItemDescription>
            </ItemContent>
          </Item>
        </div>
      ))}
    </PageRows>
  );
}

function SweepNow() {
  const { t } = useTranslation("admin");
  const sweep = useMutation(terminateInactiveComputersMutationOptions());
  return (
    <div className="mt-4 flex items-center gap-3">
      <Button
        disabled={sweep.isPending}
        onClick={() => sweep.mutate()}
        size="sm"
        variant="outline"
      >
        {sweep.isPending ? t("Stopping…") : t("Stop inactive computers now")}
      </Button>
      {sweep.data ? (
        <span className="text-muted-foreground text-sm">
          {t("Stopped {{length}}.", { length: sweep.data.stopped.length })}
        </span>
      ) : null}
      {sweep.error ? (
        <span className="text-destructive text-sm" role="alert">
          {sweep.error.message}
        </span>
      ) : null}
    </div>
  );
}

type Tri = "inherit" | "on" | "off";

function OverridesDialog({
  data,
  open,
  onOpenChange,
}: {
  data: EnterpriseOverview;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("admin");
  const { t: said } = useTranslation("server");
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const scopes: { kind: "role" | "group"; id: string; label: string }[] = [
    { kind: "role", id: "admin", label: i18n.t("Administrators") },
    { kind: "role", id: "user", label: i18n.t("Members") },
    ...data.groups.map((group) => ({
      kind: "group" as const,
      id: group,
      label: i18n.t("Group: {{group}}", { group }),
    })),
  ];
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = scopes[scopeIndex] ?? scopes[0];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Role and group overrides")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-4 overflow-y-auto">
          <Select
            onValueChange={(value) => setScopeIndex(Number(value))}
            value={String(scopeIndex)}
          >
            <SelectTrigger aria-label={t("Scope")}>
              <SelectValue>{scope?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {scopes.map((candidate, index) => (
                  <SelectItem
                    key={`${candidate.kind}:${candidate.id}`}
                    value={String(index)}
                  >
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {scope?.kind === "group"
              ? t(
                  "A group can only widen: Grant gives its members the capability even where the organization has it off.",
                )
              : t(
                  "A role's answer replaces the organization switch for everybody holding that role.",
                )}
          </p>
          {scope
            ? data.capabilities.map((capability) => {
                const stored =
                  scope.kind === "role"
                    ? capability.roles[scope.id as "admin" | "user"]
                    : capability.groups[scope.id];
                const value: Tri =
                  stored === undefined ? "inherit" : stored ? "on" : "off";
                return (
                  <div
                    className="flex items-center justify-between gap-4"
                    key={capability.capability}
                  >
                    <Label>{said(capability.title)}</Label>
                    <Select
                      onValueChange={(next) =>
                        setCapability.mutate({
                          scopeKind: scope.kind,
                          scopeId: scope.id,
                          capability: capability.capability,
                          allowed: next === "inherit" ? null : next === "on",
                        })
                      }
                      value={value}
                    >
                      <SelectTrigger
                        aria-label={t("{{title}} for {{label}}", {
                          title: said(capability.title),
                          label: scope.label,
                        })}
                        className="w-36"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="inherit">
                            {t("Inherit")}
                          </SelectItem>
                          <SelectItem value="on">
                            {scope.kind === "group" ? t("Grant") : t("On")}
                          </SelectItem>
                          {scope.kind === "role" ? (
                            <SelectItem value="off">{t("Off")}</SelectItem>
                          ) : null}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })
            : null}
          {setCapability.error ? (
            <p className="text-destructive text-sm" role="alert">
              {setCapability.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" type="button">
            {t("Done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NetworkDialog({
  data,
  initial,
  onClose,
}: {
  data: EnterpriseOverview;
  initial: { scopeKind: "organization" | "group"; scopeId: string };
  onClose: () => void;
}) {
  const { t } = useTranslation("admin");
  const existing = data.network.find(
    (row) =>
      row.scopeKind === initial.scopeKind && row.scopeId === initial.scopeId,
  );
  const [group, setGroup] = useState(initial.scopeId || data.groups[0] || "");
  const [mode, setMode] = useState<NetworkMode>(
    existing?.mode ?? "defaults_plus_allowlist",
  );
  const [rules, setRules] = useState(rulesToText(existing?.rules ?? []));
  const [locked, setLocked] = useState(existing?.locked ?? false);
  const save = useMutation(setNetworkPolicyMutationOptions(queryClient));
  const remove = useMutation(removeNetworkPolicyMutationOptions(queryClient));
  const scopeId = initial.scopeKind === "group" ? group : "";

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {initial.scopeKind === "organization"
              ? t("Organization network policy")
              : t("Group network policy")}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              {
                scopeKind: initial.scopeKind,
                scopeId,
                mode,
                rules: rulesFromText(rules),
                locked,
              },
              { onSuccess: onClose },
            );
          }}
        >
          <DialogBody className="mt-4 space-y-4 overflow-y-auto">
            {initial.scopeKind === "group" && !initial.scopeId ? (
              <div className="space-y-1.5">
                <Label>{t("Group")}</Label>
                <Select
                  onValueChange={(value) => setGroup(String(value))}
                  value={group}
                >
                  <SelectTrigger aria-label={t("Group")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {data.groups.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>{t("Mode")}</Label>
              <Select
                onValueChange={(value) => setMode(value as NetworkMode)}
                value={mode}
              >
                <SelectTrigger aria-label={t("Mode")}>
                  <SelectValue>{t(MODE_NAMES[mode])}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(MODE_NAMES) as NetworkMode[]).map(
                      (candidate) => (
                        <SelectItem key={candidate} value={candidate}>
                          {t(MODE_NAMES[candidate])}
                        </SelectItem>
                      ),
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="network-rules">{t("Allowlist")}</Label>
              <Textarea
                className="font-mono text-xs"
                id="network-rules"
                onChange={(event) => setRules(event.target.value)}
                placeholder={
                  // i18n-ignore: an example of the format, not prose
                  "example.com\n*.corp.example\n10.0.0.0/8 443,5432"
                }
                rows={8}
                value={rules}
              />
              <p className="text-muted-foreground text-xs">
                {t(
                  "One per line. A domain covers its subdomains; *.name covers only subdomains. An IP range may name ports. Defaults are {{defaultDestinations}} and {{more}} more package and source hosts.",
                  {
                    defaultDestinations: data.defaultDestinations
                      .slice(0, 4)
                      .join(", "),
                    more: data.defaultDestinations.length - 4,
                  },
                )}
              </p>
            </div>
            {initial.scopeKind === "organization" ? (
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="network-locked">
                  {t("Lock: groups may not replace this policy")}
                </Label>
                <Switch
                  checked={locked}
                  id="network-locked"
                  onCheckedChange={setLocked}
                />
              </div>
            ) : null}
            {(save.error ?? remove.error) ? (
              <p className="text-destructive text-sm" role="alert">
                {(save.error ?? remove.error)?.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            {existing ? (
              <Button
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(
                    { scopeKind: initial.scopeKind, scopeId },
                    { onSuccess: onClose },
                  )
                }
                size="sm"
                type="button"
                variant="destructive"
              >
                {t("Remove policy")}
              </Button>
            ) : null}
            <Button onClick={onClose} size="sm" type="button" variant="outline">
              {t("Cancel")}
            </Button>
            <Button
              disabled={
                save.isPending || (initial.scopeKind === "group" && !scopeId)
              }
              size="sm"
              type="submit"
            >
              {save.isPending ? t("Saving…") : t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ListDialog({
  open,
  title,
  description,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  initial: string[];
  onSave: (values: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("admin");
  const [text, setText] = useState(initial.join("\n"));
  return (
    <Dialog
      onOpenChange={(next) => (next ? setText(initial.join("\n")) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-2 overflow-y-auto">
          <Textarea
            className="font-mono text-xs"
            onChange={(event) => setText(event.target.value)}
            rows={8}
            value={text}
          />
          <p className="text-muted-foreground text-xs">{description}</p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("Cancel")}
          </Button>
          <Button
            onClick={() => {
              onSave(
                text
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              );
              onClose();
            }}
            size="sm"
            type="button"
          >
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DaysDialog({
  open,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  initial: number;
  onSave: (days: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("admin");
  const [days, setDays] = useState(String(initial));
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650;
  return (
    <Dialog
      onOpenChange={(next) => (next ? setDays(String(initial)) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Stop inactive computers")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-2">
          <Label htmlFor="inactive-days">{t("Days without use")}</Label>
          <Input
            id="inactive-days"
            inputMode="numeric"
            onChange={(event) => setDays(event.target.value)}
            value={days}
          />
          <p className="text-muted-foreground text-xs">
            {t("0 turns it off. Checked hourly.")}
          </p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("Cancel")}
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSave(parsed);
              onClose();
            }}
            size="sm"
            type="button"
          >
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
