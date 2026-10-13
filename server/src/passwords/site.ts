import { getDomain } from "tldts";

/**
 * Whether two origins are the same site, for a login that moves between steps.
 *
 * A person who typed a login for `www.example.com` agreed to it going to that site. When the site's
 * own username step sends the browser to `login.example.com`, the login may follow; when it sends it
 * to `id.other.net`, it may not, because the person never saw that host (the form said "Filled
 * directly to www.example.com"). Same site here is the browser's notion: the same scheme and the
 * same registrable domain, the port aside.
 *
 * The registrable domain is the Public Suffix List's, private section included (`tldts`), so
 * `a.s3.amazonaws.com` and `b.s3.amazonaws.com`, or two shops on `myshopify.com`, are two sites.
 * When the list gives none (an IP address, `localhost`, a bare suffix), only the exact host is the
 * same site.
 *
 * MULTI-TENANT SIGN-IN SERVICES the list does not mark. On `acme.okta.com` and `evil.okta.com`
 * every subdomain is a different customer, and the list reads both as `okta.com`. A login typed for
 * one tenant must never follow a move to another, so any host under these domains is the same site
 * only as itself. Kept short and to services people sign in through; add to it, never trim it.
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
