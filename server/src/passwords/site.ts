/**
 * Whether two origins are the same site, for a login that moves between steps.
 *
 * A person who typed a login for `www.example.com` agreed to it going to that site. When the site's
 * own username step sends the browser to `login.example.com`, the login may follow; when it sends it
 * to `id.other.net`, it may not, because the person never saw that host (the form said "Filled
 * directly to www.example.com"). Same site here is the browser's notion: the same scheme and the
 * same registrable domain (one label under the public suffix), the port aside.
 *
 * CONSERVATIVE BY CONSTRUCTION. There is no public-suffix list in this repository, so this one errs
 * towards "not the same site", which only ever costs the person a second look at the form:
 *  - a short list of multi-part public suffixes (`co.uk`, `com.gr`, `gov.gr`, `com.au`, ...);
 *  - hosting suffixes whose subdomains belong to different people (`github.io`, `vercel.app`, ...);
 *  - any other two-letter country code under a two- or three-letter label (`xx.yy`) is treated as a
 *    suffix too, so `a.abc.de` and `b.abc.de` are different sites even if `abc.de` is a company;
 *  - an IP address, or a host with a single label, is the same site only as itself.
 */

const MULTI_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "nhs.uk",
  "com.gr",
  "gov.gr",
  "edu.gr",
  "org.gr",
  "net.gr",
  "com.cy",
  "gov.cy",
  "com.au",
  "net.au",
  "org.au",
  "gov.au",
  "edu.au",
  "co.nz",
  "org.nz",
  "govt.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "go.jp",
  "ac.jp",
  "co.kr",
  "or.kr",
  "go.kr",
  "com.br",
  "gov.br",
  "org.br",
  "net.br",
  "com.cn",
  "gov.cn",
  "net.cn",
  "org.cn",
  "com.tw",
  "gov.tw",
  "com.hk",
  "gov.hk",
  "com.sg",
  "gov.sg",
  "co.in",
  "gov.in",
  "net.in",
  "org.in",
  "co.za",
  "gov.za",
  "org.za",
  "com.mx",
  "gob.mx",
  "com.ar",
  "gob.ar",
  "com.tr",
  "gov.tr",
  "co.il",
  "gov.il",
  "com.ua",
  "gov.ua",
  "com.pl",
  "gov.pl",
  "com.es",
  "gob.es",
  "co.id",
  "go.id",
  "co.th",
  "go.th",
  "com.vn",
  "gov.vn",
  "com.ph",
  "gov.ph",
  "com.eg",
  "gov.eg",
  "com.sa",
  "gov.sa",
  // Hosting: every subdomain is somebody else's.
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "fly.dev",
  "onrender.com",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "blogspot.com",
  "wixsite.com",
  "glitch.me",
  "ngrok.io",
  "ngrok-free.app",
  "trycloudflare.com",
]);

/** The registrable domain of a host, or the host itself when it has none this can trust. */
export function registrableDomain(host: string): string {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(name) || name.includes(":") || name.startsWith("["))
    return name;
  const labels = name.split(".");
  if (labels.length < 2) return name;
  let suffixLength = 1;
  for (const length of [3, 2]) {
    if (labels.length > length - 1) {
      const candidate = labels.slice(-length).join(".");
      if (MULTI_PART_SUFFIXES.has(candidate)) {
        suffixLength = length;
        break;
      }
    }
  }
  const tld = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  if (suffixLength === 1 && tld.length === 2 && /^[a-z]{2,3}$/.test(second))
    suffixLength = 2;
  if (labels.length <= suffixLength) return name;
  return labels.slice(-(suffixLength + 1)).join(".");
}

/** The same scheme and the same registrable domain. Anything that does not parse is not. */
export function sameSite(first: string, second: string): boolean {
  try {
    const a = new URL(first);
    const b = new URL(second);
    return (
      a.protocol === b.protocol &&
      registrableDomain(a.hostname) === registrableDomain(b.hostname)
    );
  } catch {
    return false;
  }
}
