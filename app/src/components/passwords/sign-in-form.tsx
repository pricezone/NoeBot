import { IconKey, IconPointer } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  hostOf,
  PILL_CLASS,
  SecureField,
  SecureNote,
} from "@/components/chat-cards/secure-form";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  cancelSignInMutationOptions,
  confirmSavedLoginMutationOptions,
  continueSignInMutationOptions,
  finishSignInMutationOptions,
  submitSignInMutationOptions,
  takeOverSignInMutationOptions,
} from "@/lib/passwords/mutations";
import {
  FINAL_SIGN_IN,
  signInRequestQueryOptions,
} from "@/lib/passwords/queries";
import { signInNote } from "@/lib/passwords/sign-in-words";
import { queryClient } from "@/query-client";

/**
 * The private sign-in form.
 *
 * Outside the conversation on purpose: what is typed here goes to the server in one request and from
 * there straight into the Bot's browser. It is never a chat message, a tool argument or a tool
 * result, so the model never sees it, and the transcript never holds it. The password lives in this
 * component's state until it is sent and is cleared the moment it is.
 *
 * Four answers: type a login, confirm a saved one, take over the browser, or decline. While the site
 * waits for the person to approve the sign-in on their phone, it says so and offers Continue.
 *
 * Every sentence here is for the person (sign-in-words.ts); what the Bot is told stays in its tool
 * result.
 */
export function SignInForm({ requestId }: { requestId: string }) {
  const request = useQuery({
    ...signInRequestQueryOptions(requestId),
    // Polled so a takeover finishing elsewhere, or the request expiring, shows here.
    refetchInterval: (query) =>
      query.state.data && FINAL_SIGN_IN.includes(query.state.data.status)
        ? false
        : 3_000,
  });
  const submit = useMutation(submitSignInMutationOptions(queryClient));
  const confirmSaved = useMutation(
    confirmSavedLoginMutationOptions(queryClient),
  );
  const takeOver = useMutation(takeOverSignInMutationOptions(queryClient));
  const finish = useMutation(finishSignInMutationOptions(queryClient));
  const cancel = useMutation(cancelSignInMutationOptions(queryClient));
  const continueApproval = useMutation(
    continueSignInMutationOptions(queryClient),
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [save, setSave] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const id = useId();

  if (request.isPending) return null;
  if (request.error)
    return (
      <p className="text-destructive text-sm" role="alert">
        {request.error.message}
      </p>
    );
  const data = request.data;
  const busy =
    submit.isPending ||
    confirmSaved.isPending ||
    takeOver.isPending ||
    finish.isPending ||
    cancel.isPending ||
    continueApproval.isPending;
  const failure =
    submit.error ??
    confirmSaved.error ??
    takeOver.error ??
    finish.error ??
    cancel.error ??
    continueApproval.error;
  const host = hostOf(data.origin) ?? data.origin;

  if (FINAL_SIGN_IN.includes(data.status)) {
    const signedIn = data.status === "signed_in";
    const codeNext = data.attempt?.outcome === "code-requested";
    return (
      <PageSection
        title={signedIn ? "Signed in" : codeNext ? "Submitted" : "Closed"}
      >
        <p className="text-muted-foreground text-sm">
          {signedIn
            ? `You are signed in to ${host}.${data.attempt?.rememberDeviceLeftUnchecked ? " “Remember this device” was left unchecked." : ""}`
            : (signInNote({
                status: data.status,
                ...(data.attempt?.outcome
                  ? { outcome: data.attempt.outcome }
                  : {}),
                ...(data.attempt?.pageMessage
                  ? { pageMessage: data.attempt.pageMessage }
                  : {}),
                host,
              }) ?? "This sign-in request is no longer open.")}
        </p>
      </PageSection>
    );
  }

  if (data.status === "filling" && data.approvalUntil)
    return (
      <PageSection
        title="Waiting for approval on your phone"
        description={`${host} asked your phone or app to approve this sign-in. Approve it there, then press Continue.`}
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => continueApproval.mutate(requestId)}
          >
            {continueApproval.isPending ? "Checking…" : "Continue"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => cancel.mutate(requestId)}
          >
            Cancel
          </Button>
        </div>
        {failure ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
      </PageSection>
    );

  if (data.status === "taken_over")
    return (
      <PageSection
        title="Sign in by hand"
        description="Take the Bot's browser, sign in, and hand it back. Then say you are done so the Bot carries on."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            render={
              <Link to="/bot" search={{ agent: data.botId, watch: true }} />
            }
          >
            Open the Bot's browser
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => finish.mutate(requestId)}
          >
            {finish.isPending ? "Finishing…" : "I've signed in"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => cancel.mutate(requestId)}
          >
            Cancel
          </Button>
        </div>
        {failure ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
      </PageSection>
    );

  const requestedHost = hostOf(data.requestedOrigin);
  const codeOnly = data.form === "code";
  const usernameLabel = data.usernameLabel ?? "Username or email";
  const passwordLabel = data.passwordLabel ?? "Password";
  const codeLabel =
    data.codeLabel ?? (codeOnly ? "Confirmation code" : "Verification code");
  // One place for what went wrong: the attempt just made, else the last one the server remembers.
  // Both used to be printed, the same sentence twice, at the top and above the buttons.
  const problem = failure?.message ?? data.outcome ?? null;
  const ready = codeOnly
    ? code.trim().length > 0
    : username.trim().length > 0 && password.length > 0;

  return (
    <form
      autoComplete="off"
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        submit.mutate(
          {
            id: requestId,
            input: codeOnly
              ? { code }
              : {
                  ...(username ? { username } : {}),
                  password,
                  ...(code ? { code } : {}),
                  save,
                },
          },
          {
            // Cleared whatever happened: a failed attempt is retyped, never kept.
            onSettled: () => {
              setPassword("");
              setCode("");
            },
          },
        );
      }}
    >
      {requestedHost && requestedHost !== host ? (
        <p className="text-muted-foreground text-sm">
          The Bot was on {requestedHost}; the sign-in form is on {host}.
        </p>
      ) : null}
      {!codeOnly && data.savedLogins.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">Use a saved login</p>
          {data.savedLogins.map((login) => (
            <div
              className="flex items-center gap-3 rounded-xl bg-background/40 px-3 py-2 dark:bg-muted/40"
              key={login.id}
            >
              <IconKey
                aria-hidden="true"
                className="size-4 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate text-[15px]">
                {login.username}
              </span>
              <Button
                className="rounded-full"
                disabled={busy}
                onClick={() =>
                  confirmSaved.mutate(
                    {
                      id: requestId,
                      loginId: login.id,
                      ...(code ? { code } : {}),
                    },
                    { onSettled: () => setCode("") },
                  )
                }
                size="sm"
                type="button"
                variant="secondary"
              >
                Use
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {codeOnly ? (
        <SecureField
          autoFocus
          kind="code"
          label={codeLabel}
          name="code"
          onChange={setCode}
          value={code}
        />
      ) : (
        <>
          <SecureField
            autoFocus
            label={usernameLabel}
            name="username"
            onChange={setUsername}
            value={username}
          />
          <SecureField
            kind="password"
            label={passwordLabel}
            name="password"
            onChange={setPassword}
            value={password}
          />
          {showCode ? (
            <SecureField
              kind="code"
              label={codeLabel}
              name="code"
              onChange={setCode}
              required={false}
              value={code}
            />
          ) : null}
        </>
      )}
      <SecureNote host={host} />
      {!codeOnly && (data.passwordManager || !showCode) ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          {data.passwordManager ? (
            <label className="flex items-center gap-2" htmlFor={`${id}-save`}>
              <Checkbox
                checked={save}
                id={`${id}-save`}
                onCheckedChange={(checked) => setSave(checked === true)}
              />
              Save to Passwords
            </label>
          ) : null}
          {showCode ? null : (
            <button
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              onClick={() => setShowCode(true)}
              type="button"
            >
              The site also asks for a code
            </button>
          )}
        </div>
      ) : null}
      {problem ? (
        <p className="text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button
            disabled={busy}
            onClick={() => takeOver.mutate(requestId)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <IconPointer />
            Sign in by hand
          </Button>
          <Button
            disabled={busy}
            onClick={() => cancel.mutate(requestId)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Decline
          </Button>
        </div>
        <Button
          className={PILL_CLASS}
          disabled={!ready || busy}
          type="submit"
          variant="secondary"
        >
          {submit.isPending || confirmSaved.isPending ? "Sending…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}
