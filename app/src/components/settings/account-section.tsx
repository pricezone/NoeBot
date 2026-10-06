import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@/components/ui/settings-rows";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { clearReturnTo } from "@/lib/return-to";

/** The first letters of up to two names, or of the email when there is no name. */
export function initialsOf(user: {
  name?: string | null;
  email: string;
}): string {
  const fromName = user.name
    ?.trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return fromName || user.email.slice(0, 2).toUpperCase();
}

/**
 * Who is signed in, and the way out.
 *
 * One identity per deployment: the platform signs a person in through a hand-off, so there is no
 * account to add or switch here, only the one to read and leave. The email has a copy button
 * because it is the thing people most often need to paste somewhere else — into a share dialog,
 * into a support message — and selecting text inside a modal row is fiddly.
 */
export function AccountSection() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [copied, setCopied] = useState(false);

  const handleSignOut = async () => {
    await signOut.mutateAsync();
    // The modal's way back is a chat this person no longer has a session for.
    clearReturnTo();
    await navigate({ to: "/sign" });
  };

  const copyEmail = async () => {
    if (!user) return;
    try {
      await navigator.clipboard.writeText(user.email);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard in this context (an insecure origin, a denied permission): nothing to say.
    }
  };

  return (
    <SettingsSection label="Account">
      <SettingsCard>
        <SettingsRow
          label={
            <span className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-medium text-foreground/80"
              >
                {user ? initialsOf(user) : ""}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{user?.name ?? user?.email}</span>
                {user?.name ? (
                  <span className="truncate text-[13px] text-muted-foreground">
                    {user.email}
                  </span>
                ) : null}
              </span>
            </span>
          }
          control={
            <Button
              aria-label={copied ? "Email copied" : "Copy email"}
              disabled={!user}
              onClick={copyEmail}
              size="icon"
              variant="ghost"
            >
              {copied ? <IconCheck /> : <IconCopy />}
            </Button>
          }
        />
        <SettingsRow
          label="Sign out"
          description="Ends this session on this browser."
          control={
            <Button
              disabled={signOut.isPending}
              onClick={handleSignOut}
              size="sm"
              variant="outline"
            >
              Sign out
            </Button>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
