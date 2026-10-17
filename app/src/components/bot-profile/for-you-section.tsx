import {
  IconBell,
  IconMessage,
  IconPlayerPause,
  IconRefresh,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  resetBotMutationOptions,
  setBotNotifyMutationOptions,
  setBotPausedMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type BotNotify,
  botLifecycleQueryOptions,
  botResetPlanQueryOptions,
  type ResetPlan,
} from "@/lib/bot-lifecycle/queries";
import { msg, useTranslation } from "@/lib/i18n";
import { queryClient } from "@/query-client";

const NOTIFY_LABEL: Record<BotNotify, string> = {
  all: msg("Everything"),
  needs_input: msg("Only when it needs me"),
  none: msg("Nothing (badges only)"),
};

const selectClass = "h-8 rounded-md border bg-background px-2 text-sm";

/** Each count the notice lists, in the words the person reads, skipping the kinds with nothing. */
function resetLines(plan: ResetPlan): string[] {
  const lines: [number, string, string][] = [
    [plan.conversations, "conversation", "conversations"],
    [plan.memorySources, "memory source", "memory sources"],
    [plan.memories, "imported memory", "imported memories"],
    [plan.routines, "routine", "routines"],
    [plan.responsibilities, "responsibility", "responsibilities"],
    [plan.followUps, "scheduled follow-up", "scheduled follow-ups"],
    [plan.formedMemories, "memory it formed", "memories it formed"],
    [plan.backgroundResearch, "background research", "background research"],
    [plan.standingApprovals, "standing permission", "standing permissions"],
  ];
  return lines
    .filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
}

function ResetDialog({
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentProfile;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useTranslation();
  const plan = useQuery({
    ...botResetPlanQueryOptions(agent.id),
    enabled: open,
  });
  const reset = useMutation(resetBotMutationOptions(queryClient));
  const lines = plan.data ? resetLines(plan.data) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("Reset {{name}}?", { name: agent.name })}
          </DialogTitle>
          <DialogDescription>
            {t(
              "This deletes what {{name}} has with you, and only with you. Nobody else's conversations or data are touched. It cannot be undone.",
              { name: agent.name },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? null : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              {t("Could not count what a reset would delete.")}
            </p>
          ) : reset.isSuccess ? (
            <p className="text-sm">
              {t("Done. {{name}} starts fresh with you.", { name: agent.name })}
            </p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>{t("There is nothing of yours to delete.")}</p>
              ) : (
                <>
                  <p>{t("This will delete:")}</p>
                  <ul className="list-disc pl-5">
                    {lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.data.sharedConversationsKept > 0 ? (
                <p className="text-muted-foreground">
                  {t(
                    "{{count}} conversations are shared with other people or Bots and will be kept.",
                    {
                      count: plan.data.sharedConversationsKept,
                      defaultValue_one:
                        "{{count}} conversation is shared with other people or Bots and will be kept.",
                    },
                  )}
                </p>
              ) : null}
              <p className="text-muted-foreground">
                {t(
                  "Your own memories, the ones you told a Bot directly, are kept.",
                )}
              </p>
            </div>
          )}
          {reset.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {reset.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            {reset.isSuccess ? t("Close") : t("Cancel")}
          </Button>
          {reset.isSuccess ? null : (
            <Button
              disabled={!plan.data || lines.length === 0 || reset.isPending}
              onClick={() => reset.mutate(agent.id)}
              size="sm"
              variant="destructive"
            >
              {reset.isPending ? t("Resetting…") : t("Delete and reset")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What a Bot is doing for you, and the switches that change it: Paused, Notifications, the
 * browser's own permission while it is still unasked, and Reset.
 *
 * The rows, without the page section around them, so the Bot's own page and the bot panel beside
 * a conversation can both draw them. `includeMessage` adds the "Message {name}" row the page has;
 * the panel leaves it out, because the conversation it sits beside is that message.
 */
export function ForYouSection({
  agent,
  includeMessage = true,
}: {
  agent: AgentProfile;
  includeMessage?: boolean;
}) {
  const { t } = useTranslation();
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const pause = useMutation(setBotPausedMutationOptions(queryClient));
  const notify = useMutation(setBotNotifyMutationOptions(queryClient));
  const [resetOpen, setResetOpen] = useState(false);
  const [permission, setPermission] = useState<string>(() => {
    try {
      return typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission;
    } catch {
      return "unsupported";
    }
  });

  if (lifecycle.isPending) return null;
  if (lifecycle.error) {
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {t("Could not load this Bot's state.")}
      </p>
    );
  }

  return (
    <>
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPlayerPause />
          </ItemMedia>
          <ItemContent>
            {/* The row names what the switch does; the routines list's chips say "Paused". */}
            <ItemTitle>{t("Pause")}</ItemTitle>
            <ItemDescription>
              {lifecycle.data.paused
                ? t(
                    "No routine, responsibility, hand-off or follow-up starts for you, and what was running has stopped.",
                  )
                : t(
                    "Runs its routines, responsibilities, hand-offs and follow-ups for you.",
                  )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label={t("Pause")}
              checked={lifecycle.data.paused}
              disabled={pause.isPending}
              onCheckedChange={(paused) =>
                pause.mutate({ agentId: agent.id, paused })
              }
            />
          </ItemActions>
        </Item>
        <Separator />
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconBell />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("Notifications")}</ItemTitle>
            <ItemDescription>
              {t("{{value}}. Sidebar badges always show.", {
                value: t(NOTIFY_LABEL[lifecycle.data.notify]),
              })}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <select
              aria-label={t("Notifications")}
              className={selectClass}
              disabled={notify.isPending}
              onChange={(event) =>
                notify.mutate({
                  agentId: agent.id,
                  notify: event.target.value as BotNotify,
                })
              }
              value={lifecycle.data.notify}
            >
              {(Object.keys(NOTIFY_LABEL) as BotNotify[]).map((value) => (
                <option key={value} value={value}>
                  {t(NOTIFY_LABEL[value])}
                </option>
              ))}
            </select>
          </ItemActions>
        </Item>
        {permission === "default" ? (
          <>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBell />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("Browser notifications")}</ItemTitle>
                <ItemDescription>
                  {t(
                    "Off in this browser. Turn them on to hear when a Bot needs you.",
                  )}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  onClick={async () => {
                    try {
                      setPermission(await Notification.requestPermission());
                    } catch {
                      setPermission("unsupported");
                    }
                  }}
                  size="sm"
                  variant="outline"
                >
                  {t("Turn on")}
                </Button>
              </ItemActions>
            </Item>
          </>
        ) : null}
        {includeMessage ? (
          <>
            <Separator />
            <Item
              render={<Link to="/channel/new" search={{ agent: agent.id }} />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconMessage />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {t("Message {{name}}", { name: agent.name })}
                </ItemTitle>
                <ItemDescription>{t("Start a conversation.")}</ItemDescription>
              </ItemContent>
            </Item>
          </>
        ) : null}
        <Separator />
        <Item
          render={<button onClick={() => setResetOpen(true)} type="button" />}
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconRefresh />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("Reset")}</ItemTitle>
            <ItemDescription>
              {t(
                "Delete your conversations with it, what it remembers for you, and its scheduled work. You see what will go first.",
              )}
            </ItemDescription>
          </ItemContent>
        </Item>
      </PageRows>
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
    </>
  );
}
