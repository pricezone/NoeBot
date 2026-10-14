import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { brand } from "@/lib/brand";
import {
  type HostAccessPendingOperation,
  type HostFolderGrant,
  hostAccessQueryOptions,
  requestHostFolderGrantMutationOptions,
  revokeHostFolderGrantMutationOptions,
  stopHostAccessMutationOptions,
} from "@/lib/computers/host-access";
import { setComputerStateMutationOptions } from "@/lib/computers/mutations";
import { computerFleetQueryOptions } from "@/lib/computers/queries";
import { i18n, Trans, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/i18n/format";

export const Route = createFileRoute("/_authed/_app/admin/computers")({
  component: ComputersPage,
});

function ComputersPage() {
  const { t } = useTranslation("admin");
  /** Bot id currently running a stop/reset request. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the browser profile, so it requires confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Updating restarts a running computer mid-task, so it is confirmed too. */
  const [confirmingUpdate, setConfirmingUpdate] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const nameFor = useBotNames();

  const fleet = useQuery(computerFleetQueryOptions());
  const hostAccess = useQuery(hostAccessQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const setState = useMutation(setComputerStateMutationOptions(queryClient));
  const requestGrant = useMutation(
    requestHostFolderGrantMutationOptions(queryClient),
  );
  const revokeGrant = useMutation(
    revokeHostFolderGrantMutationOptions(queryClient),
  );
  const stopHostAccess = useMutation(
    stopHostAccessMutationOptions(queryClient),
  );

  const computers = fleet.data?.computers ?? null;
  const isolation = fleet.data?.isolation ?? null;
  /*
   * A list that could not be read. A refused stop, reset or update is said beside the buttons
   * instead, because the top of this page is a long scroll away from them.
   */
  const problem = fleet.error
    ? i18n.t("The computers could not be listed.")
    : null;
  const hostProblem = hostAccess.error
    ? hostAccess.error.message
    : requestGrant.error
      ? requestGrant.error.message
      : revokeGrant.error
        ? revokeGrant.error.message
        : stopHostAccess.error
          ? stopHostAccess.error.message
          : null;

  const run = (botId: string, action: "stop" | "reset" | "update") => {
    setBusy(botId);
    setConfirming(null);
    setConfirmingUpdate(null);
    setState.mutate({ action, botId }, { onSettled: () => setBusy(null) });
  };

  return (
    <PageShell
      description={t(
        "Each Bot's browser and the profile it keeps. A profile is what makes a Bot still signed in tomorrow, and resetting one signs it out of everything.",
      )}
      title={t("Computers")}
    >
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {isolation === "shared" ? (
        <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <Trans
            t={t}
            i18nKey="<strong>Every Bot is sharing one computer.</strong> They share its logins, its files and its session, so a Bot can reach what another signed into. Set <code>COMPUTER_SUPERVISOR_URL</code> to give each Bot its own."
            components={{
              strong: <span className="font-medium" />,
              code: <code />,
            }}
          />
        </p>
      ) : isolation === "per-bot" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          {t(
            "Each Bot has a computer of its own: its own container, its own files and its own browser profile.",
          )}
        </p>
      ) : null}

      <HostFoldersSection
        connected={hostAccess.data?.connected ?? false}
        grants={hostAccess.data?.grants ?? []}
        botIds={(agents.data ?? []).map((agent) => agent.id)}
        loading={hostAccess.isPending || agents.isPending}
        nameFor={nameFor}
        onGrant={(botId) => requestGrant.mutate({ botId })}
        onRevoke={(grantId) => revokeGrant.mutate({ grantId })}
        onStop={() => stopHostAccess.mutate()}
        pending={hostAccess.data?.pending ?? []}
        problem={hostProblem}
        requestingBotId={
          requestGrant.isPending
            ? (requestGrant.variables?.botId ?? null)
            : null
        }
        revokingGrantId={
          revokeGrant.isPending
            ? (revokeGrant.variables?.grantId ?? null)
            : null
        }
        stopping={stopHostAccess.isPending}
      />

      <PageSection title={t("Computers in this deployment")}>
        {setState.error ? (
          <p
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
          >
            {setState.error.message}
          </p>
        ) : null}
        {computers === null && problem ? (
          <PageEmpty>{t("The list could not be loaded.")}</PageEmpty>
        ) : computers === null ? null : computers.length === 0 ? (
          <PageEmpty>
            {t(
              "No computers yet. One appears the first time a Bot opens a page.",
            )}
          </PageEmpty>
        ) : (
          <PageRows>
            {computers.map((computer, index) => (
              <StaggerItem index={index} key={computer.botId}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle title={computer.botId}>
                      {nameFor(computer.botId)}
                    </ItemTitle>
                    <ItemDescription>
                      {computer.running
                        ? t("Browser running since {{value}}", {
                            value: new Date(
                              computer.startedAt ?? "",
                            ).toLocaleTimeString(intlLocale()),
                          })
                        : t(
                            "No browser running. It starts when the Bot next needs it.",
                          )}
                      {" · "}
                      {computer.egress === undefined
                        ? t("Egress not reported")
                        : computer.egress === null
                          ? t("Leaves directly")
                          : t("Leaves through {{egress}}", {
                              egress: computer.egress,
                            })}
                      {computer.updateAvailable ? t(" · Update available") : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {computer.updateAvailable ? (
                      <Button
                        disabled={busy === computer.botId}
                        onClick={() => setConfirmingUpdate(computer.botId)}
                        size="sm"
                        variant="outline"
                      >
                        {t("Update computer")}
                      </Button>
                    ) : null}
                    <Button
                      disabled={busy === computer.botId || !computer.running}
                      onClick={() => void run(computer.botId, "stop")}
                      size="sm"
                      variant="outline"
                    >
                      {busy === computer.botId
                        ? t("Working…")
                        : t("Stop browser")}
                    </Button>
                    <Button
                      disabled={busy === computer.botId}
                      onClick={() => setConfirming(computer.botId)}
                      size="sm"
                      variant="outline"
                    >
                      {t("Reset")}
                    </Button>
                  </ItemActions>
                </Item>
                {index !== computers.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      {/*
       * A DIALOG RATHER THAN AN INLINE CONFIRM. Resetting signs a Bot out of everything it has ever
       * logged into and cannot be undone, and the row it was confirmed on was one of several
       * identical-looking rows. The dialog names the Bot, so the sentence somebody agrees to says
       * which computer it destroys.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={confirming !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Reset {{name}}'s computer?", {
                name: confirming ? nameFor(confirming) : "",
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                "Its profile is deleted, so the Bot is signed out of every service it had logged into and starts clean. This cannot be undone.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirming(null)}
              size="sm"
              variant="ghost"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={busy === confirming}
              onClick={() => {
                if (confirming) void run(confirming, "reset");
              }}
              size="sm"
              variant="destructive"
            >
              {busy === confirming ? t("Resetting…") : t("Reset it")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingUpdate(null);
        }}
        open={confirmingUpdate !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("Update {{name}}'s computer?", {
                name: confirmingUpdate ? nameFor(confirmingUpdate) : "",
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                "It moves onto the computer image this deployment now runs. Its files and sign-ins are kept. If it is running it restarts, which interrupts anything it is doing right now.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirmingUpdate(null)}
              size="sm"
              variant="ghost"
            >
              {t("Cancel")}
            </Button>
            <Button
              disabled={busy === confirmingUpdate}
              onClick={() => {
                if (confirmingUpdate) void run(confirmingUpdate, "update");
              }}
              size="sm"
            >
              {busy === confirmingUpdate ? t("Updating…") : t("Update it")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="mt-4 text-muted-foreground text-sm">
        <Trans
          t={t}
          i18nKey="<strong>Stop</strong> closes the browser and keeps its logins: the next thing the Bot does starts it again where it left off. <strong>Reset</strong> deletes the profile, so the Bot is signed out of everything and starts clean. <strong>Update computer</strong> appears when a computer runs an older image than this deployment, and moves it onto the new one with its files and sign-ins kept. All three are recorded in <audit>Audit</audit>."
          components={{
            strong: <strong />,
            audit: <Link className="underline" to="/admin/audit" />,
          }}
        />
      </p>
    </PageShell>
  );
}

type HostFoldersSectionProps = {
  botIds: string[];
  connected: boolean;
  grants: HostFolderGrant[];
  loading: boolean;
  nameFor: (botId: string) => string;
  onGrant: (botId: string) => void;
  onRevoke: (grantId: string) => void;
  onStop: () => void;
  pending: HostAccessPendingOperation[];
  problem: string | null;
  requestingBotId: string | null;
  revokingGrantId: string | null;
  stopping: boolean;
};

function HostFoldersSection({
  botIds: knownBotIds,
  connected,
  grants,
  loading,
  nameFor,
  onGrant,
  onRevoke,
  onStop,
  pending,
  problem,
  requestingBotId,
  revokingGrantId,
  stopping,
}: HostFoldersSectionProps) {
  const { t } = useTranslation("admin");
  const botIds = Array.from(
    new Set([
      ...knownBotIds,
      ...grants.map((grant) => grant.botId),
      ...pending.map((one) => one.botId),
    ]),
  ).sort((left, right) => nameFor(left).localeCompare(nameFor(right)));

  return (
    <PageSection
      description={t(
        "Choose folders a Bot can read on this computer. The desktop app asks before each edit or command. Access ends when you stop {{productName}}.",
        { productName: brand.productName },
      )}
      title={t("Folders on this computer")}
    >
      {problem ? (
        <p
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {!connected && !loading ? (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          {t(
            "The desktop app is offline. Folders can only be approved from the desktop app, and command access stays unavailable while it is offline.",
          )}
        </p>
      ) : null}

      {loading ? null : botIds.length === 0 ? (
        <PageEmpty>
          {t("No Bots yet. Create a Bot before choosing folders.")}
        </PageEmpty>
      ) : (
        <PageRows>
          {botIds.map((botId, index) => (
            <StaggerItem index={index} key={botId}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle title={botId}>{nameFor(botId)}</ItemTitle>
                  <ItemDescription>
                    {summaryFor(botId, grants, pending)}
                  </ItemDescription>
                  <FolderGrantList
                    botId={botId}
                    grants={grants}
                    onRevoke={onRevoke}
                    pending={pending}
                    revokingGrantId={revokingGrantId}
                  />
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={!connected || requestingBotId === botId}
                    onClick={() => onGrant(botId)}
                    size="sm"
                    variant="outline"
                  >
                    {requestingBotId === botId
                      ? t("Waiting…")
                      : t("Choose folder")}
                  </Button>
                </ItemActions>
              </Item>
              {index !== botIds.length - 1 && <Separator />}
            </StaggerItem>
          ))}
        </PageRows>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-sm">
        <p>
          {t(
            "Grants are read-only by default. Writes are requested from the native desktop prompt when a Bot needs them.",
          )}
        </p>
        <div className="flex items-center gap-3">
          <Button
            disabled={!connected || stopping}
            onClick={onStop}
            size="sm"
            variant="outline"
          >
            {stopping ? t("Stopping…") : t("Stop folder access")}
          </Button>
          <Link className="underline" to="/admin/audit">
            {t("View audit")}
          </Link>
        </div>
      </div>
    </PageSection>
  );
}

function FolderGrantList({
  botId,
  grants,
  onRevoke,
  pending,
  revokingGrantId,
}: {
  botId: string;
  grants: HostFolderGrant[];
  onRevoke: (grantId: string) => void;
  pending: HostAccessPendingOperation[];
  revokingGrantId: string | null;
}) {
  const { t } = useTranslation("admin");
  const botGrants = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  );
  const botPending = pending.filter((request) => request.botId === botId);

  if (botGrants.length === 0 && botPending.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {botGrants.map((grant) => (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
          key={grant.id}
        >
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">{grant.displayName}</p>
            <p className="text-muted-foreground text-xs">
              {t("{{value}} · Read-only", { value: ownerLabel(grant) })}
            </p>
          </div>
          <Button
            disabled={revokingGrantId === grant.id}
            onClick={() => onRevoke(grant.id)}
            size="sm"
            variant="ghost"
          >
            {revokingGrantId === grant.id ? t("Revoking…") : t("Revoke")}
          </Button>
        </div>
      ))}
      {botPending.map((request) => (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          key={request.operationId}
        >
          {t("{{value}} from {{value2}}", {
            value: pendingLabel(request),
            value2: ownerLabel(request),
          })}
          {request.displayName
            ? t(" for {{displayName}}", { displayName: request.displayName })
            : ""}
          .
        </div>
      ))}
    </div>
  );
}

function summaryFor(
  botId: string,
  grants: HostFolderGrant[],
  pending: HostAccessPendingOperation[],
) {
  const active = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  ).length;
  const waiting = pending.filter((request) => request.botId === botId).length;
  const parts = [];
  if (active > 0)
    parts.push(`${active} read-only ${active === 1 ? "folder" : "folders"}`);
  if (waiting > 0)
    parts.push(`${waiting} pending ${waiting === 1 ? "request" : "requests"}`);
  return parts.length > 0 ? parts.join(" · ") : i18n.t("No folders approved.");
}

function ownerLabel(grant: { ownerName?: string; ownerEmail?: string }) {
  return grant.ownerName ?? grant.ownerEmail ?? "the desktop owner";
}

function pendingLabel(request: HostAccessPendingOperation) {
  switch (request.kind) {
    case "write_file":
      return i18n.t("File change awaiting approval or completion");
    case "run_command":
      return i18n.t("Command awaiting approval or completion");
    case "list_files":
      return i18n.t("Listing files");
    case "read_file":
      return i18n.t("Reading a file");
    case "cancel":
    case "stop":
      return i18n.t("Stopping folder work");
    default:
      return i18n.t("Folder access awaiting approval");
  }
}
