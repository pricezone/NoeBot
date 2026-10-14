import { IconLock, IconShieldCheck, IconUser } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { terminateMemberComputersMutationOptions } from "@/lib/enterprise/mutations";
import { i18n, useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/i18n/format";
import {
  setPersonAccessMutationOptions,
  setPersonRoleMutationOptions,
} from "@/lib/people/mutations";
import { type Person, peopleListQueryOptions } from "@/lib/people/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/_app/admin/people")({
  component: PeoplePage,
});

/** What each provider is called, since the id it registers under is not a name. */
const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  okta: "Okta",
};

/**
 * The second line of a person's row: how they got here, and when they were last here.
 *
 * The address is the title, so this is everything else worth knowing at a glance while deciding
 * whether somebody should still have access.
 */
function describe(person: Person): string {
  const providers = person.providers
    .map((provider) => PROVIDER_NAMES[provider] ?? provider)
    .join(", ");
  const when = person.lastSignedInAt
    ? i18n.t("last signed in {{date}}", {
        date: new Date(person.lastSignedInAt).toLocaleDateString(intlLocale()),
      })
    : i18n.t("never signed in");

  if (person.revoked)
    return `${i18n.t("Access removed")} · ${providers || i18n.t("no provider")} · ${when}`;
  if (person.configuredAdmin) {
    return `${i18n.t("Administrator by configuration")} · ${when}`;
  }
  return `${providers || i18n.t("no provider")} · ${when}`;
}

function PeoplePage() {
  const { t } = useTranslation("admin");
  const [search, setSearch] = useState("");
  /*
   * Debounced, so typing a name is one request rather than one per keystroke against an aggregate
   * over every user in the deployment.
   */
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const people = useInfiniteQuery(peopleListQueryOptions(query));
  const rows = people.data?.pages.flatMap((page) => page.people) ?? [];
  const currentUser = useQuery(currentUserQueryOptions());
  const setRole = useMutation(setPersonRoleMutationOptions(queryClient));
  const setAccess = useMutation(setPersonAccessMutationOptions(queryClient));
  // Offboarding: stops this person's Bots' computers, keeping their disks. Access is unchanged.
  const terminate = useMutation(terminateMemberComputersMutationOptions());

  // The server refuses these too. Disabling them here is so the screen does not offer something it
  // knows will be refused, not so the rule is enforced in the browser.
  const failure = setRole.error ?? setAccess.error ?? terminate.error;

  return (
    <PageShell
      description={t(
        "Everybody who has signed in. Administrators reach these screens; everybody else talks to Bots.",
      )}
      title={t("People")}
    >
      <PageSection
        description={t(
          "An address named in INITIAL_ADMIN_EMAILS is an administrator whatever this screen says, so it cannot be changed here.",
        )}
        title={t("Who is here")}
      >
        {failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
        {terminate.data ? (
          <p className="mt-4 text-muted-foreground text-sm" role="status">
            {terminate.data.failed.length > 0
              ? t(
                  "Stopped {{count}} computers; {{failed}} could not be stopped. Their disks are kept.",
                  {
                    count: terminate.data.stopped.length,
                    failed: terminate.data.failed.length,
                    defaultValue_one:
                      "Stopped {{count}} computer; {{failed}} could not be stopped. Their disks are kept.",
                  },
                )
              : t("Stopped {{count}} computers. Their disks are kept.", {
                  count: terminate.data.stopped.length,
                  defaultValue_one:
                    "Stopped {{count}} computer. Their disks are kept.",
                })}
          </p>
        ) : null}
        {/*
          Server-side search. Filtering what already arrived would only search the first page, which
          is the opposite of what somebody looking for a colleague needs.
        */}
        <Input
          aria-label={t("Search people")}
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("Search by name or address")}
          value={search}
        />

        {people.isPending ? null : people.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("Could not load people.")}
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>
            {query
              ? t('Nobody here matches "{{query}}".', { query })
              : t("Nobody has signed in yet. People appear here once they do.")}
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((person, index) => {
              const isSelf = person.id === currentUser.data?.id;
              const busy = setRole.isPending || setAccess.isPending;

              return (
                <StaggerItem index={index} key={person.id}>
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      {person.revoked ? (
                        <IconLock />
                      ) : person.role === "admin" ? (
                        <IconShieldCheck />
                      ) : (
                        <IconUser />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{person.name ?? person.email}</ItemTitle>
                      <ItemDescription>
                        {person.name ? `${person.email} · ` : ""}
                        {describe(person)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Removing access is the louder decision, so it is a button rather than a
                       * second switch: two switches on one row invites somebody to flip the wrong
                       * one, and these two do very different things.
                       */}
                      <Button
                        disabled={terminate.isPending}
                        onClick={() => terminate.mutate(person.id)}
                        size="sm"
                        variant="outline"
                      >
                        {t("Stop computers")}
                      </Button>
                      <Button
                        disabled={busy || isSelf || person.configuredAdmin}
                        onClick={() =>
                          setAccess.mutate({
                            userId: person.id,
                            revoked: !person.revoked,
                          })
                        }
                        size="sm"
                        variant={person.revoked ? "outline" : "destructive"}
                      >
                        {person.revoked ? t("Restore") : t("Remove")}
                      </Button>
                      <Switch
                        aria-label={t("Administrator: {{email}}", {
                          email: person.email,
                        })}
                        checked={person.role === "admin"}
                        disabled={busy || person.configuredAdmin || isSelf}
                        onCheckedChange={(checked) =>
                          setRole.mutate({
                            userId: person.id,
                            role: checked ? "admin" : "user",
                          })
                        }
                      />
                    </ItemActions>
                  </Item>
                  {index !== rows.length - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}

        {/*
          Only when there is one. A button that says there is more when there is not is worse than
          no button, and this list ends for most deployments on the first page.
        */}
        {people.hasNextPage ? (
          <Button
            className="mt-4"
            disabled={people.isFetchingNextPage}
            onClick={() => people.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {people.isFetchingNextPage ? t("Loading…") : t("Show more")}
          </Button>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
