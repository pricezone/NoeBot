import { IconDots, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { removeSkillMutationOptions } from "@/lib/plugins/mutations";
import {
  type PluginSkill,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * Personal `/` skills, listed. They are instructions, not capabilities, and can only be granted to
 * Bots the signed-in user owns.
 *
 * Extracted from the old `/skills` page so the Marketplace's Skills tab can draw it. Writing and
 * editing a skill stay search parameters on the Marketplace (`?new`, `?edit=slug`), so the list
 * stays on screen behind the form and the form is linkable, reloadable, and closed by Back.
 */
export function SkillsSections({ query = "" }: { query?: string }) {
  const queryClient = useQueryClient();
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
  const [error, setError] = useState<string | null>(null);

  const removeSkill = useMutation({
    ...removeSkillMutationOptions(queryClient),
    onError: (thrown: Error) => setError(thrown.message),
    onSuccess: () => setError(null),
  });

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
  const skills = matchingSkills(data?.skills ?? [], query);
  const mine = skills.filter((skill) => skill.ownerUserId === me?.id);
  const deployment = skills.filter((skill) => skill.ownerUserId === null);

  return (
    <>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        action={
          <Button
            render={(props) => (
              <Link
                search={{ tab: "skills", new: true }}
                to="/marketplace"
                {...props}
              />
            )}
            size="sm"
            variant="secondary"
          >
            <IconPlus />
            New skill
          </Button>
        }
        className="mt-0"
        title="Your skills"
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
            Your skills could not be loaded.
          </p>
        ) : mine.length === 0 ? (
          <Empty className="mt-4 h-[180px] border border-dashed">
            <EmptyHeader>
              <EmptyTitle className="text-muted-foreground">
                {query.trim()
                  ? `No skills of yours match “${query.trim()}”.`
                  : "You don't have any skills yet."}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <PageRows>
            {mine.map((skill, index) => (
              <StaggerItem index={index} key={skill.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{skill.title}</ItemTitle>
                    {/*
                     * THE COMMAND FIRST, because it is the only part a person has to know. The title
                     * says what the skill is for; `/slug` is what they actually type, and a page that
                     * lists skills without showing how to invoke one leaves them guessing at it.
                     *
                     * The interpunct only appears when there is a summary to separate it from —
                     * a trailing "· " on a skill written without one reads as something missing.
                     */}
                    <ItemDescription>
                      <code className="font-mono text-foreground/80 text-xs">
                        /{skill.slug}
                      </code>
                      {skill.summary ? ` · ${skill.summary}` : null}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-sm">
                            <IconDots />
                          </Button>
                        }
                      ></DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            onClick={() =>
                              navigate({
                                to: "/marketplace",
                                search: { tab: "skills", edit: skill.slug },
                              })
                            }
                          >
                            Edit
                          </DropdownMenuItem>
                          {/*
                           * Deleting is immediate and there is no undo. It is behind a menu rather
                           * than sitting on the row for that reason, and the slug is named in the
                           * label so the destructive item says WHICH skill it destroys — a menu
                           * opened over the wrong row is the ordinary way this goes wrong.
                           */}
                          <DropdownMenuItem
                            onClick={() => {
                              setError(null);
                              removeSkill.mutate(skill.slug);
                            }}
                            variant="destructive"
                          >
                            Delete /{skill.slug}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ItemActions>
                </Item>
                {index !== mine.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      {/*
       * NO MENU ON THESE ROWS, AND THAT IS THE POINT. A workspace skill belongs to the deployment,
       * not to the person reading this page: they cannot edit it, delete it, or choose which Bots
       * carry it. Drawing the same dropdown here and refusing on click would be a worse answer than
       * not offering it — the server refuses either way, and an affordance that only ever fails is
       * a promise the page cannot keep.
       *
       * Hidden entirely when there are none, rather than shown empty: an administrator who has
       * written nothing yet is the normal case, and a permanently empty section reads as broken.
       */}
      {deployment.length > 0 ? (
        <PageSection
          className="mt-8"
          description="Written for everyone by an administrator. Which Bots carry them is decided in Admin."
          title="Workspace skills"
        >
          <PageRows>
            {deployment.map((skill, index) => (
              <StaggerItem index={index} key={skill.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{skill.title}</ItemTitle>
                    <ItemDescription>
                      <code className="font-mono text-foreground/80">
                        /{skill.slug}
                      </code>
                      {skill.summary ? ` · ${skill.summary}` : null}
                    </ItemDescription>
                  </ItemContent>
                </Item>
                {index !== deployment.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
    </>
  );
}

/** The skills whose title, slug or summary contains the query. An empty query keeps them all. */
export function matchingSkills(
  skills: PluginSkill[],
  query: string,
): PluginSkill[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return skills;
  return skills.filter((skill) =>
    `${skill.title} /${skill.slug} ${skill.summary}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}
