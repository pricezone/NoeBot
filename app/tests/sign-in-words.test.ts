import { expect, test } from "bun:test";
import {
  askAgainText,
  canAskAgain,
  finishedState,
  signInNote,
} from "@/lib/passwords/sign-in-words";

/**
 * The words a person reads about their sign-in: never the Bot's sentence, always what happened to
 * them and what they can do next.
 */

const host = "example.com";

test("a refused login says wrong password or code, with the site's own message", () => {
  expect(
    signInNote({
      status: "pending",
      outcome: "error",
      pageMessage: "Incorrect password",
      host,
    }),
  ).toBe("Wrong password or code. The site says: “Incorrect password”");
  expect(signInNote({ status: "pending", host })).toBeUndefined();
});

test("a wait for the phone, a code next, an expiry, a decline and a stop each read as themselves", () => {
  expect(
    signInNote({ status: "filling", waitingForApproval: true, host }),
  ).toContain("Waiting for approval on your phone");
  expect(
    signInNote({ status: "failed", outcome: "code-requested", host }),
  ).toBe(
    "Your login went in. example.com now asks for a code; your Bot will ask you for it.",
  );
  expect(signInNote({ status: "expired", host })).toBe(
    "This sign-in request expired before anyone signed in.",
  );
  expect(signInNote({ status: "cancelled", host })).toBe(
    "You declined this sign-in.",
  );
  expect(signInNote({ status: "cancelled", stopped: true, host })).toBe(
    "The sign-in was stopped.",
  );
  expect(signInNote({ status: "failed", outcome: "push-approval", host })).toBe(
    "No approval arrived on your phone in time.",
  );
  expect(signInNote({ status: "signed_in", host })).toBeUndefined();
});

test("Ask again is offered whenever it ended without a login going in", () => {
  expect(canAskAgain({ status: "expired", host })).toBe(true);
  expect(canAskAgain({ status: "cancelled", host })).toBe(true);
  expect(canAskAgain({ status: "failed", outcome: "error", host })).toBe(true);
  expect(canAskAgain({ status: "signed_in", host })).toBe(false);
  expect(
    canAskAgain({ status: "failed", outcome: "code-requested", host }),
  ).toBe(false);
  expect(
    finishedState({ status: "failed", outcome: "code-requested", host }),
  ).toBe("submitted");
  expect(askAgainText(host)).toBe(
    "Ask me again for the sign-in to example.com",
  );
});
