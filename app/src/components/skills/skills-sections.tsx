import {
  IconBolt,
  IconPlayerRecordFilled,
  IconPlus,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { botLandingTarget } from "@/components/app-sidebar/bot-target";
import { ACTION_CLASS } from "@/components/marketplace/plugin-action";
import {
  MarketplaceGrid,
  MarketplaceSection,
  PluginRow,
} from "@/components/marketplace/plugin-row";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  type AgentProfile,
  agentListQueryOptions,
  isSharedWithYou,
} from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { useTranslation } from "@/lib/i18n";
import { useContentText } from "@/lib/i18n/content";
import {
  type PluginSkill,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * "Record skill": the way to a Bot's screen with Record your steps in front of you, which lives
 * in the computer view. One Bot you may use and the button goes
 * straight to its newest conversation (or a fresh one) with `panel=computer&record=true`, which
 * opens the viewer full-window on arrival; several and it asks which Bot's computer records.
 * Nothing is pressed for the person: taking over the Bot's browser stays their press.
 */
function RecordSkillButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const agents = useQuery(agentListQueryOptions());
  const roster = useInfiniteQuery(channelListQueryOptions());
  const bots = (agents.data ?? [])
    .filter((agent) => agent.mine || isSharedWithYou(agent))
    .sort((left, right) => Number(right.pinned) - Number(left.pinned));

  const record = (bot: AgentProfile) => {
    const target = botLandingTarget(bot.id, roster.data, agents.data);
    void navigate(
      target.to === "/channel/new"
        ? /*
           * No conversation with the Bot yet. Its own screen rather than the composer: the
           * composer would ask for a first message before any screen exists, and a recording is
           * not a message.
           */
          {
            to: "/bot",
            search: { agent: bot.id, panel: "computer", record: true },
          }
        : {
            to: target.to,
            params: target.params,
            search: { panel: "computer", record: true },
          },
    );
  };

  const label = (
    <>
      <IconPlayerRecordFilled aria-hidden="true" className="text-red-500" />
      {t("Record skill")}
    </>
  );
  if (bots.length <= 1) {
    const only = bots[0];
    return (
      <Button
        disabled={only === undefined}
        onClick={() => only && record(only)}
        size="sm"
        title={only === undefined ? t("Create a Bot first") : undefined}
        type="button"
        variant="secondary"
      >
        {label}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="sm" type="button" variant="secondary">
            {label}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          {bots.map((bot) => (
            <DropdownMenuItem key={bot.id} onClick={() => record(bot)}>
              <NoeBotAvatar
                color={bot.avatarColor}
                expression={bot.avatarExpression}
                seed={bot.avatarSeed}
                size={20}
              />
              {bot.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Personal `/` skills, listed. They are instructions, not capabilities, and can only be granted to
 * Bots the signed-in user owns.
 *
 * Drawn with the Marketplace's own rows — the tile, the name, one line, the action on the right —
 * so the Skills tab reads as the Apps tab does, every skill behind the same lightning mark. The
 * action is Edit for a skill of yours and View for the workspace's; both open the panel beside the
 * list (`?edit=slug`), where deleting also lives, so the row carries one control and the
 * destructive one sits behind the panel rather than a menu over the wrong row. Writing a new one
 * is `?new`, so the form is linkable, reloadable, and closed by Back.
 */
export function SkillsSections({ query = "" }: { query?: string }) {
  const { t } = useTranslation();
  const content = useContentText();
  const navigate = useNavigate();
  const { data, isPending: skillsPending } = useQuery(
    pluginsPageQueryOptions(),
  );
  const { data: me, isPending: mePending } = useQuery(
    currentUserQueryOptions(),
  );
  /*
   * Both, because `mine` is the intersection of the two: until the person is known, nothing matches
   * them and the list is empty for a reason that is not "you have no skills".
   */
  const loading = skillsPending || mePending;

  /*
   * The server has ALREADY excluded skills this person may not see — `listSkills` scopes the query
   * to `owner_user_id is null or owner_user_id = me`, so somebody else's private skill is never read
   * into the process. These lines only sort what arrived into the two things the tab draws, and
   * narrow them to the Marketplace's search term.
   *
   * ONE CASE FALLS THROUGH ON PURPOSE, FOR NOW: an administrator receives everybody's skills, and
   * another person's lands in neither list. Not a leak, but an administrator cannot see here what
   * they are entitled to. Worth an owner column or a third section before this page is called done.
   */
  const skills = matchingSkills(data?.skills ?? [], query, content);
  const mine = skills.filter((skill) => skill.ownerUserId === me?.id);
  const deployment = skills.filter((skill) => skill.ownerUserId === null);

  /* The term travels with every link out of the list, so Back lands on the same list. */
  const search = {
    tab: "skills" as const,
    ...(query.trim() === "" ? {} : { q: query }),
  };
  const open = (skill: PluginSkill) =>
    navigate({ to: "/marketplace", search: { ...search, edit: skill.slug } });

  const row = (skill: PluginSkill, action: "Edit" | "View") => (
    <PluginRow
      action={
        <Link
          aria-label={
            action === "Edit"
              ? t("Edit {{title}}", { title: content(skill.title) })
              : t("View {{title}}", { title: content(skill.title) })
          }
          className={cn(
            buttonVariants({ size: "sm", variant: "secondary" }),
            ACTION_CLASS,
          )}
          search={{ ...search, edit: skill.slug }}
          to="/marketplace"
        >
          {action === "Edit" ? t("Edit") : t("View")}
        </Link>
      }
      data-testid={`skill-${skill.slug}`}
      key={skill.id}
      mark={<IconBolt aria-hidden="true" data-mark="skill" />}
      onOpen={() => open(skill)}
      openLabel={t("About {{name}}", { name: content(skill.title) })}
      /*
       * The command when there is no summary: `/slug` is what a person actually types, and a row
       * that shows neither leaves them guessing at it.
       */
      summary={skill.summary ? content(skill.summary) : `/${skill.slug}`}
      title={content(skill.title)}
    />
  );

  return (
    <>
      <MarketplaceSection
        action={
          <div className="flex items-center gap-2">
            <Button
              render={(props) => (
                <Link
                  search={{ ...search, new: true }}
                  to="/marketplace"
                  {...props}
                />
              )}
              size="sm"
              variant="secondary"
            >
              <IconPlus />
              {t("New skill")}
            </Button>
            <RecordSkillButton />
          </div>
        }
        title={t("Your skills")}
      >
        {/*
         * Nothing while the two queries are still in flight. The alternative is the empty state
         * standing there saying this person has written no skills, which is a claim the page has
         * not yet earned.
         *
         * And not after a read that failed, for the same reason: `isPending` goes false on a
         * failed fetch too, and no list is no evidence of no skills. A list already held stays on
         * screen through a failed refetch, because `data` is still there.
         */}
        {loading ? null : !data ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("Your skills could not be loaded.")}
          </p>
        ) : mine.length === 0 ? (
          <Empty className="mt-4 h-[180px] border border-dashed">
            <EmptyHeader>
              <EmptyTitle className="text-muted-foreground">
                {query.trim()
                  ? t("No skills of yours match “{{query}}”.", {
                      query: query.trim(),
                    })
                  : t("You don't have any skills yet.")}
              </EmptyTitle>
              {query.trim() ? null : (
                <EmptyDescription>
                  {t("Write one, or record your steps on a Bot's computer.")}
                </EmptyDescription>
              )}
            </EmptyHeader>
          </Empty>
        ) : (
          <MarketplaceGrid>
            {mine.map((skill) => row(skill, "Edit"))}
          </MarketplaceGrid>
        )}
      </MarketplaceSection>

      {/*
       * VIEW, NOT EDIT, ON THESE ROWS. A workspace skill belongs to the deployment, not to the
       * person reading this page: they cannot edit it, delete it, or choose which Bots carry it,
       * and the panel it opens says so and offers only what is theirs. The server refuses the rest
       * either way, and an affordance that only ever fails is a promise the page cannot keep.
       *
       * Hidden entirely when there are none, rather than shown empty: an administrator who has
       * written nothing yet is the normal case, and a permanently empty section reads as broken.
       */}
      {deployment.length > 0 ? (
        <MarketplaceSection title={t("Workspace skills")}>
          <p className="-mt-1 mb-3 text-[13px] text-muted-foreground">
            {t(
              "Written for everyone by an administrator. Which Bots carry them is decided in Admin.",
            )}
          </p>
          <MarketplaceGrid>
            {deployment.map((skill) => row(skill, "View"))}
          </MarketplaceGrid>
        </MarketplaceSection>
      ) : null}
    </>
  );
}

/**
 * The skills whose title, slug or summary contains the query. An empty query keeps them all.
 * `translate` is how the screen shows a title or summary; both it and the English are searched.
 */
export function matchingSkills(
  skills: PluginSkill[],
  query: string,
  translate: (text: string) => string = (text) => text,
): PluginSkill[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return skills;
  return skills.filter((skill) =>
    `${skill.title} /${skill.slug} ${skill.summary} ${translate(skill.title)} ${translate(skill.summary ?? "")}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}
