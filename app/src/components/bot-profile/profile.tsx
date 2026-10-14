import { IconRoute } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { AvatarChooser } from "@/components/agents/avatar-chooser";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import { setUpdateRoutingMutationOptions } from "@/lib/bot-lifecycle/mutations";
import {
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { msg, useTranslation } from "@/lib/i18n";
import { useContentText } from "@/lib/i18n/content";
import { queryClient } from "@/query-client";
import { BotActivitySections } from "./activity";
import { ForYouSection } from "./for-you-section";
import { BotPausedBanner } from "./pause-banner";

const KIND_LABEL: Record<UpdateKind, { title: string; description: string }> = {
  progress: {
    title: msg("Progress"),
    description: msg("Replies and results from work you were not watching."),
  },
  decision: {
    title: msg("Decisions"),
    description: msg("Approvals a Bot needs before it acts."),
  },
  question: {
    title: msg("Questions"),
    description: msg("Things a Bot asked you and is waiting on."),
  },
};

const TRANSPORTS: { id: UpdateTransport; label: string }[] = [
  { id: "push", label: msg("Push") },
  { id: "slack", label: "Slack" },
  { id: "teams", label: "Microsoft Teams" },
  { id: "sms", label: "SMS" },
];

function UpdateRoutingSection() {
  const { t } = useTranslation();
  const routing = useQuery(updateRoutingQueryOptions());
  const save = useMutation(setUpdateRoutingMutationOptions(queryClient));
  return (
    <PageSection
      description={t(
        "Where each kind of update goes when you are not looking. The web always shows everything. Applies to all your Bots.",
      )}
      title={t("Where updates go")}
    >
      {routing.isPending ? null : routing.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {t("Could not load where your updates go.")}
        </p>
      ) : (
        <PageRows>
          {(Object.keys(KIND_LABEL) as UpdateKind[]).map((kind, index) => {
            const current = routing.data[kind];
            const allowed = (transport: UpdateTransport) =>
              current === "all" || current.includes(transport);
            return (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconRoute />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{t(KIND_LABEL[kind].title)}</ItemTitle>
                    <ItemDescription>
                      {t(KIND_LABEL[kind].description)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemFooter className="gap-4 pl-8">
                    {TRANSPORTS.map((transport) => (
                      <div
                        className="flex items-center gap-2 text-sm"
                        key={transport.id}
                      >
                        <Switch
                          aria-label={t("{{title}} by {{label}}", {
                            title: t(KIND_LABEL[kind].title),
                            label: t(transport.label),
                          })}
                          checked={allowed(transport.id)}
                          disabled={save.isPending}
                          onCheckedChange={(checked) => {
                            const next = TRANSPORTS.map((t) => t.id).filter(
                              (id) =>
                                id === transport.id ? checked : allowed(id),
                            );
                            save.mutate({
                              kind,
                              transports:
                                next.length === TRANSPORTS.length
                                  ? "all"
                                  : next,
                            });
                          }}
                          size="sm"
                        />
                        {t(transport.label)}
                      </div>
                    ))}
                  </ItemFooter>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}

/** A Bot's own page: its state for you, what it is doing, and the lifecycle controls. */
export function BotProfile({ agent }: { agent: AgentProfile }) {
  const { t } = useTranslation();
  const content = useContentText();
  return (
    <>
      <div className="mt-6 flex items-center gap-3">
        <AvatarChooser
          agentId={agent.id}
          align="start"
          profile={agent}
          size={56}
        />
        <div className="min-w-0">
          <p className="truncate font-medium">{content(agent.title)}</p>
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {agent.roleDescription}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <BotPausedBanner agentId={agent.id} />
      </div>

      <PageSection title={t("For you")}>
        <ForYouSection agent={agent} />
      </PageSection>

      <BotActivitySections agentId={agent.id} />
      <UpdateRoutingSection />
    </>
  );
}
