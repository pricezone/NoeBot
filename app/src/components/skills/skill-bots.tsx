import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useTranslation } from "@/lib/i18n";
import {
  offerSkillToAllBotsMutationOptions,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import type { PluginSkill } from "@/lib/plugins/queries";

/**
 * An administrator's settings for a skill the deployment holds: whether every Bot is offered it,
 * and which Bots carry it by name.
 *
 * The same control the Admin › Skills screen draws, moved here so the Marketplace's Skills tab
 * can show it beside the skill — the owner asked for the admin settings in the tab, and one
 * component is what keeps the two screens from drifting. Nothing here edits the skill's words:
 * a package skill and a plugin's skill are read-only, and these switches are still theirs to set.
 */
export function SkillSettings({ skill }: { skill: PluginSkill }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const offer = useMutation({
    ...offerSkillToAllBotsMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => setError(null),
  });

  return (
    <section aria-label={t("Skill settings")} className="flex flex-col gap-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        {t("Settings")}
      </h2>
      <Item size="sm" variant="muted">
        <ItemContent>
          <ItemTitle>{t("Offered to every Bot")}</ItemTitle>
          <ItemDescription>
            {skill.offeredToAllBots
              ? t(
                  "Every Bot may run this playbook, without a grant. Switch this off to decide per Bot below.",
                )
              : t(
                  "Only the Bots granted it below may run it. Switch this on to offer it to every Bot.",
                )}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch
            aria-label={t("Offer {{title}} to every Bot", {
              title: skill.title,
            })}
            checked={skill.offeredToAllBots}
            disabled={offer.isPending}
            onCheckedChange={(next) =>
              offer.mutate({ slug: skill.slug, on: next })
            }
          />
        </ItemActions>
      </Item>
      <SkillBots grantedTo={skill.grantedTo} slug={skill.slug} />
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Which Bots carry a skill, one toggle per Bot the deployment has — filled when granted. An
 * administrator's list is every Bot; the mutation is the same grant a person makes for a Bot of
 * their own.
 */
export function SkillBots({
  slug,
  grantedTo,
}: {
  slug: string;
  grantedTo: readonly string[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: agents } = useQuery(agentListQueryOptions());
  const nameFor = useBotNames();
  const [error, setError] = useState<string | null>(null);
  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => setError(null),
  });
  const bots = (agents ?? []).map((agent) => ({
    id: agent.id,
    name: nameFor(agent.id),
  }));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t("Bots that carry it")}</p>
      {bots.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("No Bots yet.")}</p>
      ) : (
        <div
          className="flex flex-wrap gap-2"
          data-testid={`skill-bots-${slug}`}
        >
          {bots.map((bot) => {
            const held = grantedTo.includes(bot.id);
            return (
              <Button
                aria-pressed={held}
                key={bot.id}
                onClick={() =>
                  setGrant.mutate({
                    agentId: bot.id,
                    granted: !held,
                    kind: "skill",
                    ref: slug,
                  })
                }
                size="sm"
                type="button"
                variant={held ? "default" : "outline"}
              >
                {bot.name}
              </Button>
            );
          })}
        </div>
      )}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
