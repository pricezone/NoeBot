/**
 * The private sign-in, in the words every side of it shares.
 *
 * One description for `computer_request_sign_in`, registered by the server's headless tool and by the
 * open chat, so an unattended Bot and a Bot in the chat are promised the same thing. One list of the
 * ways a sent login can end, read by the computer that types it, the server that records it and the
 * card that shows it. And one tool result, built the same way on both paths, so the Bot reads the same
 * sentence whichever side waited for the person.
 *
 * Nothing here is about one site. Examples name kinds of pages, never a portal, a country or a
 * language, because a Bot copies examples literally.
 */

export const SIGN_IN_TOOL_DESCRIPTION = [
  "Ask the person you work for to sign you in to a website: a bank, a government or tax portal, a shop, any login.",
  "They get a private Secure Form in this conversation (or take over the browser), and what they type goes straight into your browser by the computer.",
  "You never see the username, password or code, so do not refuse a login as too personal and never ask for credentials any other way.",
  "Open the sign-in page first: click the site's own Sign in button and wait until the login fields show, even when that page is on another site (a site that sends you to an identity provider).",
  "When the site first asks which way to sign in (with an email, a bank, a national ID, a social account), pick the way the person named; if they did not say, the site's main option; if there is no clear main option, ask them which.",
  "Then call this with the address of the page that shows the fields and a short title in the person's language.",
  "For a code that arrives later on a page of its own (an SMS or authenticator code page), call this again on that page: it asks for the code alone.",
  "This turn pauses until they answer. You are then told only how it went, in `outcome`: signed-in; error (the site refused it, and `pageMessage` quotes what it said); code-requested (the site now wants a one-time code: call this again at once); push-approval (the site waited for approval on the person's phone and none came); captcha (a security check appeared and the person was handed the browser).",
].join(" ");

/** How the page answered a login, a username step or a code the computer sent. */
export type SignInOutcome =
  | "signed-in"
  | "error"
  | "code-requested"
  | "push-approval"
  | "captcha";

/** The last check made after sending something, as the server remembers it beside the request. */
export type SignInAttempt = {
  outcome: SignInOutcome;
  /** The site's own words near the form, such as its error, trimmed. Never a credential. */
  pageMessage?: string;
  /** The form had a "remember this device" box, and it was left unchecked. */
  rememberDeviceLeftUnchecked?: boolean;
};

type Method = "typed" | "saved" | "takeover";

const METHOD_WORDS: Record<Method, string> = {
  typed: "the person entered a login in a private form",
  saved: "the person confirmed one of their saved logins",
  takeover: "the person took over the browser and signed in themselves",
};

/**
 * What the Bot is told when a request ends: the only thing about a sign-in that reaches a model.
 *
 * Built from the request as the server keeps it (its status, its outcome sentence) and the last
 * check the computer made. `outcome` is the check's word, or `signed-in` once the request is signed
 * in by any route; `pageMessage` is the site's own message, which never contains what the person
 * typed (the server removes it before it is kept).
 */
export function signInResultForBot(request: {
  status: string;
  origin: string;
  method?: Method | null;
  outcome?: string | null;
  attempt?: SignInAttempt;
  /** The site the login was first typed for, when it went on to another one and was asked again. */
  movedFrom?: string;
}) {
  const signedIn = request.status === "signed_in";
  const attempt = request.attempt;
  let result =
    request.outcome ??
    (signedIn
      ? `Signed in to ${request.origin}.`
      : `The sign-in to ${request.origin} did not complete.`);
  if (!signedIn && attempt?.outcome === "error")
    result += attempt.pageMessage
      ? ` The site refused the last attempt and said: "${attempt.pageMessage}".`
      : " The site refused the last attempt.";
  if (request.movedFrom)
    result += ` The sign-in went from ${request.movedFrom} on to ${request.origin}, a different site, so nothing was typed there and the person was asked again for ${request.origin}.`;
  if (attempt?.rememberDeviceLeftUnchecked)
    result +=
      " A 'remember this device' box was left unchecked, so the site may ask for a code again next time.";
  const outcome: SignInOutcome | undefined = signedIn
    ? "signed-in"
    : attempt?.outcome;
  return {
    ok: signedIn,
    signedIn,
    site: request.origin,
    status: request.status,
    ...(request.method ? { method: METHOD_WORDS[request.method] } : {}),
    ...(request.movedFrom ? { movedFrom: request.movedFrom } : {}),
    ...(outcome ? { outcome } : {}),
    ...(!signedIn && attempt?.pageMessage
      ? { pageMessage: attempt.pageMessage }
      : {}),
    result,
    note: "You were not told the credentials and must never ask for them another way.",
  };
}
