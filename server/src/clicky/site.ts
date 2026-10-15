import { registrableDomain } from "../passwords/site";

/**
 * The site a page is on, as "Allow for this session" and the link rule count it: the registrable
 * domain (`gov.gr` for `www.gov.gr` and `dilosi.services.gov.gr`), or the exact host where the Public
 * Suffix List names none or the host is one tenant of a multi-tenant sign-in service. The same rule
 * the private sign-in uses for a login that moves between steps (`passwords/site.ts`).
 */
export function siteOfHost(host: string | undefined): string | undefined {
  const name = host?.toLowerCase().replace(/\.$/, "");
  if (!name) return undefined;
  return registrableDomain(name) ?? name;
}

/** The site of a page address, or nothing for an address that does not parse. */
export function siteOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return siteOfHost(new URL(url).hostname);
  } catch {
    return undefined;
  }
}
