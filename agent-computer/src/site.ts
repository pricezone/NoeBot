import { getDomain } from "tldts";

/**
 * Whether two origins are the same site, on the computer's side of the private sign-in.
 *
 * The same rule as `server/src/passwords/site.ts`, which explains it; this copy exists because the
 * computer is its own package and image and cannot import the server. A test holds the two lists
 * of tenant domains equal. Here it decides whether a login drawn in a frame may be typed at all: only
 * when the page around the frame is the same site as the origin the person approved, because that
 * page controls the frame and could swap what is in it.
 */
export const TENANT_DOMAINS = [
  "okta.com",
  "oktapreview.com",
  "okta-emea.com",
  "okta-gov.com",
  "auth0.com",
  "onelogin.com",
  "duosecurity.com",
  "sharepoint.com",
  "my.salesforce.com",
  "force.com",
  "atlassian.net",
  "zendesk.com",
  "freshdesk.com",
  "service-now.com",
  "myworkday.com",
  "b2clogin.com",
  "ciamlogin.com",
  "amazoncognito.com",
];

/**
 * The registrable domain of a host, or undefined when nothing but the exact host can stand for it:
 * the list gives none, or the host belongs to a multi-tenant sign-in service.
 */
export function registrableDomain(host: string): string | undefined {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (
    TENANT_DOMAINS.some(
      (domain) => name === domain || name.endsWith(`.${domain}`),
    )
  )
    return undefined;
  return getDomain(name, { allowPrivateDomains: true }) ?? undefined;
}

/** The same scheme and the same registrable domain (or the same host). Anything unparsable is not. */
export function sameSite(first: string, second: string): boolean {
  try {
    const a = new URL(first);
    const b = new URL(second);
    if (a.protocol !== b.protocol) return false;
    if (a.hostname === b.hostname) return true;
    const domain = registrableDomain(a.hostname);
    return Boolean(domain && domain === registrableDomain(b.hostname));
  } catch {
    return false;
  }
}
