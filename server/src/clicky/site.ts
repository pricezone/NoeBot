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

/**
 * An address Show me how may open: https only, with a host, and no name or password in it. A bare
 * name ("gov.gr", "www.gov.gr/dilosi") is read as https. Anything else (`http:`, `javascript:`,
 * `data:`, `file:`, an address with credentials) is null.
 */
export function openableUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000 || /\s/.test(trimmed)) return null;
  // A scheme is a word before "://" or a colon before the first slash ("javascript:", "data:").
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname?.includes(".")) return null;
  return url.toString();
}

/**
 * The sites a person named in their own words: every name that reads as a web address ("gov.gr",
 * "www.gov.gr", "https://dilosi.services.gov.gr/"), lower-cased, without a leading "www.".
 */
export function sitesNamedIn(texts: readonly string[]): string[] {
  const named = new Set<string>();
  for (const text of texts)
    for (const match of text
      .toLowerCase()
      .matchAll(
        /(?:^|[^a-z0-9.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![a-z0-9-])/g,
      )) {
      const name = match[1]?.replace(/^www\./, "");
      if (name?.includes(".")) named.add(name);
    }
  return [...named];
}

/**
 * Whether the person named the site an address is on: the very host, a host under a name they
 * gave ("gov.gr" covers "www.gov.gr" and "dilosi.services.gov.gr"), or the same site as one they
 * gave.
 */
export function namedSite(named: readonly string[], url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  const site = siteOfHost(host);
  return named.some(
    (name) =>
      host === name ||
      host.endsWith(`.${name}`) ||
      (site !== undefined && siteOfHost(name) === site),
  );
}
