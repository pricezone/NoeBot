import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SkillAgents } from "@/components/skills/skill-agents";
import { SkillFields } from "@/components/skills/skill-fields";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  offerSkillToAllBotsMutationOptions,
  removeSkillMutationOptions,
  saveSkillMutationOptions,
} from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * Editing a skill, in the same panel that writes one.
 *
 * THERE IS NO EDIT ENDPOINT, AND NONE IS NEEDED. `POST /api/plugins/skills` upserts on the slug:
 * `installSkill` does `onConflictDoUpdate` and deliberately leaves `owner_user_id` alone, so a
 * re-save changes the words and never quietly changes whose skill it is. The route has already
 * refused anyone editing a skill that is not theirs before it gets that far.
 *
 * WHOSE SKILL IT IS DECIDES WHAT THE PANEL OFFERS. The form, Save and Delete are the owner's and
 * an administrator's; anybody else gets the skill to read, with the Bots of theirs it may be
 * granted to. The server refuses the rest either way, so a form that only ever failed on Save was
 * a promise the panel could not keep — and a workspace skill opened by a member used to be one.
 *
 * `onClose` is the Skills tab's own way of closing the panel, which keeps the search term; a
 * caller without one (a test drawing the panel alone) lands on the plain Skills tab.
 */
export function EditSkill({
  slug,
  onClose,
}: {
  slug: string;
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isPending } = useQuery(pluginsPageQueryOptions());
  const removeSkill = useMutation(removeSkillMutationOptions(queryClient));
  const close = () =>
    onClose
      ? onClose()
      : navigate({ search: { tab: "skills" }, to: "/marketplace" });

  /*
   * Read from the list already on screen rather than fetched again. It is the same request the page
   * behind this panel just made, so react-query serves it from cache and the form is filled on the
   * first frame instead of flashing empty fields at somebody who came here to change one word.
   */
  const skill = data?.skills.find((candidate) => candidate.slug === slug);

  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));
  const me = useQuery(currentUserQueryOptions());
  const offer = useMutation(offerSkillToAllBotsMutationOptions(queryClient));

  /* Nothing while it loads. "Missing" and "not yet arrived" must not read the same. */
  if (isPending) return null;

  /*
   * No list is not a missing skill. `isPending` goes false on a failed read too, and the sentence
   * below tells somebody their skill is gone, or was never theirs, on no evidence at all.
   */
  if (!data) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
        <p className="text-destructive text-sm" role="alert">
          This skill could not be loaded.
        </p>
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
        {/*
         * Said plainly rather than shown as an empty form. A skill can be missing because it was
         * deleted in another tab, or because the link names one that is somebody else's — and an
         * empty form here would invite them to write it back into existence under a slug they may
         * not own.
         */}
        <p className="text-muted-foreground text-sm">
          That skill no longer exists, or it is not yours to edit.
        </p>
      </div>
    );
  }

  /*
   * A plugin's skill is the plugin's: pinned to its commit, replaced or removed with the plugin
   * and never on its own. Read here, with the one thing an administrator decides about it —
   * whether every Bot holds it, or only the Bots granted it below.
   */
  if (skill.pluginId) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold">{skill.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Installed from a Marketplace plugin. It is replaced or removed with
            the plugin, from a connected account's page.
          </p>
        </header>
        {skill.summary ? <p className="text-sm">{skill.summary}</p> : null}
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/60 p-4 text-xs">
          {skill.instructions}
        </pre>
        {me.data?.role === "admin" ? (
          <Item size="sm" variant="muted">
            <ItemContent>
              <ItemTitle>Offered to every Bot</ItemTitle>
              <ItemDescription>
                {skill.offeredToAllBots
                  ? "Every Bot may run this playbook, without a grant. Switch this off to decide per Bot below."
                  : "Only the Bots granted it below may run it. Switch this on to offer it to every Bot."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={`Offer ${skill.title} to every Bot`}
                checked={skill.offeredToAllBots}
                disabled={offer.isPending}
                onCheckedChange={(next) =>
                  offer.mutate({ slug: skill.slug, on: next })
                }
              />
            </ItemActions>
          </Item>
        ) : null}
        {offer.error ? (
          <p className="text-destructive text-sm" role="alert">
            {offer.error.message}
          </p>
        ) : null}
        <SkillAgents grantedTo={skill.grantedTo} slug={skill.slug} />
      </div>
    );
  }

  /* Nothing until the person is known: the two panels below must not flash one into the other. */
  if (me.isPending) return null;
  const person = me.data ?? null;
  const mayEdit =
    person !== null &&
    (skill.ownerUserId === person.id || person.role === "admin");

  if (!mayEdit) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold">{skill.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A workspace skill, written for everyone by an administrator. Which
            Bots carry it is decided in Admin.
          </p>
        </header>
        {skill.summary ? <p className="text-sm">{skill.summary}</p> : null}
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/60 p-4 text-xs">
          {skill.instructions}
        </pre>
        <SkillAgents grantedTo={skill.grantedTo} slug={skill.slug} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Edit skill</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Changes apply the next time <code>/{skill.slug}</code> is used. Agents
          already carrying it keep it.
        </p>
      </header>

      <SkillFields
        defaultValues={{
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary ?? "",
          instructions: skill.instructions,
          // Defaulted, so a skill written before this field existed opens with nothing ticked rather
          // than with an undefined the form would refuse to submit.
          tools: skill.tools ?? [],
        }}
        error={saveSkill.error}
        /*
         * Passed down rather than rendered after the form, so it lands above Save changes. Granting
         * still saves on its own the instant a button is pressed — `SkillFields` keeps it out of the
         * form's state and only decides where it sits.
         */
        footer={<SkillAgents grantedTo={skill.grantedTo} slug={skill.slug} />}
        onSubmit={async (values) => {
          await saveSkill.mutateAsync(values);
          await close();
        }}
        slugLocked
        submitLabel="Save changes"
      />

      {/*
       * Deleting is immediate and there is no undo. It sits under the form rather than on the
       * list's row, and the slug is named in the label so the destructive control says WHICH
       * skill it destroys.
       */}
      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">
          Bots carrying it lose it at once. There is no undo.
        </p>
        <Button
          className="shrink-0 text-destructive hover:text-destructive"
          disabled={removeSkill.isPending}
          onClick={() =>
            removeSkill.mutate(skill.slug, { onSuccess: () => close() })
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          {removeSkill.isPending ? "Deleting…" : `Delete /${skill.slug}`}
        </Button>
      </div>
      {removeSkill.error ? (
        <p className="text-destructive text-sm" role="alert">
          {removeSkill.error.message}
        </p>
      ) : null}
    </div>
  );
}
