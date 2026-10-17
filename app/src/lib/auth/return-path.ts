/**
 * Where to come back to after signing in, so a link into the app survives the sign-in on the way.
 *
 * `_authed` sends somebody who is not signed in to `/sign?redirect=<the path and search they
 * asked for>`; every way in from there carries it: the provider buttons as their callback, the
 * platform handoff through `/api/noebot/open?to=`, and an already signed-in visit to `/sign` as
 * a redirect. Only an in-app path is ever honoured — a single leading `/`, no backslash, no
 * control character — so the parameter cannot send anybody to another site; the server's handoff
 * endpoint checks it again (`localRedirect`).
 */
export function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return undefined;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  const path = value.split(/[?#]/, 1)[0] ?? "";
  // Home needs no carrying, and the sign-in screen is never somewhere to come back to.
  if (path === "/" || path === "/sign" || path.startsWith("/sign/")) {
    return undefined;
  }
  return value;
}

/** The `redirect` of the address the browser is on (the sign-in screen's), when it is safe. */
export function returnPathFromLocation(): string | undefined {
  const search = window.location.search ?? "";
  return safeReturnPath(new URLSearchParams(search).get("redirect"));
}
