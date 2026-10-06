import { IconKey, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { SettingsCard, SettingsSection } from "@/components/ui/settings-rows";
import { deleteSavedLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/_app/settings/passwords")({
  component: PasswordsPage,
});

/**
 * The logins you saved from a private sign-in form.
 *
 * The site and username only: a password is write-only, and this page can delete one but never show
 * it. A saved login is used only when you confirm it in a sign-in form.
 *
 * Drawn in the Settings frame, not `PageShell`: this is a section of the Settings modal now, and
 * the shell's sidebar toggle and full-page heading were chrome from the screen behind it.
 */
function PasswordsPage() {
  const logins = useQuery(savedLoginsQueryOptions());
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <SettingsPage
      title="Passwords"
      description="Logins you saved when signing a Bot in to a website. A Bot never sees them, and each use needs your confirmation."
    >
      <SettingsSection label="Saved logins">
        {logins.isPending ? null : logins.error ? (
          <p className="text-destructive text-sm" role="alert">
            Could not load your passwords.
          </p>
        ) : !logins.data.passwordManager ? (
          <p className="text-muted-foreground text-sm">
            Saved passwords are turned off for this workspace. Existing logins
            are kept but not offered.
          </p>
        ) : logins.data.logins.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No saved logins. Choose Save to Passwords when you sign a Bot in to
            a website.
          </p>
        ) : (
          <SettingsCard>
            {logins.data.logins.map((login, index) => (
              <div key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item className="rounded-none border-0" size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.origin}</ItemTitle>
                    <ItemDescription>
                      {login.username}
                      {login.lastUsedAt
                        ? ` · last used ${new Date(login.lastUsedAt).toLocaleDateString()}`
                        : " · never used"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`Delete the login for ${login.origin}`}
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(login.id)}
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </SettingsCard>
        )}
        {remove.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
