import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { SignInAttempt } from "../../../../shared/sign-in-guidance";

/**
 * A Bot's request to be signed in to a website, as the private form sees it.
 *
 * Never carries a credential: the form sends one and the server passes it to the Bot's computer.
 * `savedLogins` lists usernames only, and only while the workspace's password manager is on.
 */
export type SignInStatus =
  | "pending"
  | "filling"
  | "taken_over"
  | "signed_in"
  | "failed"
  | "cancelled"
  | "expired";

export type SignInRequest = {
  id: string;
  botId: string;
  origin: string;
  reason: string | null;
  status: SignInStatus;
  method: "typed" | "saved" | "takeover" | null;
  /** The last thing that happened, e.g. why a submitted login did not work. */
  outcome: string | null;
  controlRequestId: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  passwordManager: boolean;
  savedLogins: { id: string; username: string }[];
  /** The tool call that asked, so any tab drawing that call can find its request. */
  toolCallId?: string | null;
  /** What the Bot's page asked for when the request was made, read by its computer. */
  form?: "login" | "username" | "code";
  /** The site's icon, a small data URL from the Bot's browser. */
  icon?: string;
  /** The site the Bot named, when the form turned out to be on another (an identity provider). */
  requestedOrigin?: string;
  /** How the Bot titled the form and labelled its fields. */
  title?: string;
  usernameLabel?: string;
  passwordLabel?: string;
  codeLabel?: string;
  /** How the page answered the last thing the computer sent (a refusal, a code next, ...). */
  attempt?: SignInAttempt;
  /** While the site waits for the person to approve the sign-in on their phone: until when. */
  approvalUntil?: string;
  /** The site the login was typed for, when it went on to another and the form opened again. */
  movedFrom?: string;
};

export type SavedLogin = {
  id: string;
  origin: string;
  username: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export const passwordKeys = {
  all: ["passwords"] as const,
  logins: () => ["passwords", "logins"] as const,
  signIn: (id: string) => ["passwords", "sign-in", id] as const,
  pending: () => ["passwords", "sign-in", "pending"] as const,
};

export const FINAL_SIGN_IN: readonly SignInStatus[] = [
  "signed_in",
  "failed",
  "cancelled",
  "expired",
];

export function signInRequestQueryOptions(id: string) {
  return queryOptions({
    queryKey: passwordKeys.signIn(id),
    queryFn: async (): Promise<SignInRequest> =>
      (
        await client(`/api/sign-in-requests/${encodeURIComponent(id)}`, {
          fallback: "Could not load this sign-in request",
        })
      ).json(),
  });
}

/**
 * The owner's open sign-in requests. A sign-in card drawn in a tab that did not run the tool call
 * (another tab, another device, after a reload) finds its request here by the call's id; the tab that
 * ran it knows the id already.
 */
export function pendingSignInsQueryOptions() {
  return queryOptions({
    queryKey: passwordKeys.pending(),
    queryFn: async (): Promise<SignInRequest[]> =>
      (
        (await (
          await client("/api/sign-in-requests", {
            fallback: "Could not load sign-in requests",
          })
        ).json()) as { requests: SignInRequest[] }
      ).requests,
  });
}

export function savedLoginsQueryOptions() {
  return queryOptions({
    queryKey: passwordKeys.logins(),
    queryFn: async (): Promise<{
      passwordManager: boolean;
      logins: SavedLogin[];
    }> =>
      (
        await client("/api/passwords", {
          fallback: "Could not load your passwords",
        })
      ).json(),
  });
}
