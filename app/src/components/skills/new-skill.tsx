import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SkillFields } from "@/components/skills/skill-fields";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { Trans, useTranslation } from "@/lib/i18n";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { emptySkillForm } from "@/lib/skills/form";

/**
 * Writing a skill, in the detail panel beside the list.
 *
 * The panel rather than a page of its own, so the skills you already have stay on screen while you
 * write the next one — the usual reason to open this is to make a variant of one that exists.
 *
 * An administrator may write it for everybody instead: the switch sends `global`, the same
 * request Admin › Skills makes, and the skill lands under Workspace skills for every member. Off
 * by default, because a skill is personal unless somebody decides otherwise.
 */
export function NewSkill({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery(currentUserQueryOptions());
  const [isForEveryone, setIsForEveryone] = useState(false);

  const createSkill = useMutation(saveSkillMutationOptions(queryClient));
  const isAdmin = me.data?.role === "admin";

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">{t("New skill")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <Trans
            t={t}
            i18nKey="A named instruction you invoke with <code>/</code>."
            components={{ code: <code /> }}
          />{" "}
          {isForEveryone
            ? t("Offered to every Bot; members see it under Workspace skills.")
            : t("It goes on the Bots you own, and nobody else sees it.")}
        </p>
      </header>

      {isAdmin ? (
        <Item size="sm" variant="muted">
          <ItemContent>
            <ItemTitle>{t("For everyone on this deployment")}</ItemTitle>
            <ItemDescription>
              {t(
                "A workspace skill: offered to every Bot, listed for every member, and yours to look after from here.",
              )}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Switch
              aria-label={t("For everyone on this deployment")}
              checked={isForEveryone}
              onCheckedChange={setIsForEveryone}
            />
          </ItemActions>
        </Item>
      ) : null}

      <SkillFields
        defaultValues={emptySkillForm}
        error={createSkill.error}
        onSubmit={async (values) => {
          await createSkill.mutateAsync({
            ...values,
            ...(isForEveryone ? { global: true } : {}),
          });
          // Panel closed rather than swapped for a detail view: there is nothing more to say about a
          // skill than the form just said, and the new row is already behind it in the list.
          if (onClose) onClose();
          else
            await navigate({ search: { tab: "skills" }, to: "/marketplace" });
        }}
        submitLabel={t("Save skill")}
      />
    </div>
  );
}
