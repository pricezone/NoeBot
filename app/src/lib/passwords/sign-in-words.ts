import type { SecureFormState } from "@/components/chat-cards/secure-form";
import type { SignInOutcome } from "../../../../shared/sign-in-guidance";

/**
 * What the PERSON reads about a sign-in: the row in the conversation and the form's last screen.
 *
 * Never the tool result's `result`. That sentence is written for the Bot ("Nobody signed in. Do not
 * ask for the login another way.") and reads as a scolding to the person who just declined, or as
 * nonsense to one whose request simply expired. The row says what happened to them, in their terms,
 * and offers the next step: Continue while their phone is asked to approve, Ask again once it is over.
 */
export type SignInSituation = {
  /** The request's status, or the status the tool result reported. */
  status?: string;
  outcome?: SignInOutcome;
  pageMessage?: string;
  /** The site waits for the person to approve the sign-in on their phone. */
  waitingForApproval?: boolean;
  /** The chat stopped the request (the turn was stopped), rather than the person declining it. */
  stopped?: boolean;
  /** The request could not be opened at all (no form on the page, say). */
  notOpened?: boolean;
  /** The login went on to another site, and the form opened again for it. */
  movedFrom?: string;
  host: string;
};

/** The site refused what was typed, in the person's words, with the site's own when it gave some. */
export function wrongWords(pageMessage?: string) {
  return pageMessage
    ? `Wrong password or code. The site says: “${pageMessage}”`
    : "Wrong password or code.";
}

/** The line under the row, or nothing when the row's own word says it all. */
export function signInNote(situation: SignInSituation): string | undefined {
  const { status, outcome, host } = situation;
  if (situation.waitingForApproval)
    return "Waiting for approval on your phone. Approve the sign-in there, then press Continue.";
  if (status === "signed_in") return undefined;
  if (outcome === "code-requested")
    return `Your login went in. ${host} now asks for a code; your Bot will ask you for it.`;
  const wrong = outcome === "error" ? wrongWords(situation.pageMessage) : "";
  if (status === "pending" || status === "filling" || status === "taken_over")
    return situation.movedFrom && !wrong
      ? `The sign-in went on to ${host}. Open the form to check it and sign in there.`
      : wrong || undefined;
  if (outcome === "push-approval")
    return "No approval arrived on your phone in time.";
  if (status === "expired")
    return wrong
      ? `${wrong} The request then expired.`
      : "This sign-in request expired before anyone signed in.";
  if (status === "cancelled")
    return situation.stopped
      ? "The sign-in was stopped."
      : wrong
        ? `${wrong} The sign-in was then declined.`
        : "You declined this sign-in.";
  if (situation.notOpened)
    return `The sign-in form for ${host} could not be opened.`;
  return wrong || "The sign-in did not complete.";
}

/** How a finished sign-in reads on its row. */
export function finishedState(situation: SignInSituation): SecureFormState {
  if (situation.status === "signed_in") return "submitted";
  if (situation.outcome === "code-requested") return "submitted";
  if (situation.status === "expired") return "expired";
  if (situation.status === "cancelled") return "cancelled";
  return "failed";
}

/** Whether a finished row offers "Ask again": whenever it ended without a login going in. */
export function canAskAgain(situation: SignInSituation) {
  return finishedState(situation) !== "submitted";
}

/** What "Ask again" says in the conversation, as the person. */
export function askAgainText(host: string) {
  return `Ask me again for the sign-in to ${host}`;
}
