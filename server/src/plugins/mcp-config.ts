import { customUrlRefusal, readsAsCredential } from "./catalogue";
import { HEADER_NAME, VARIABLE_NAME } from "./header-template";

/**
 * A plugin's `mcp.json`, read into the servers this deployment could dial.
 *
 * What a plugin author wrote is one of several dialects — Cursor's own, the Agent Plugins
 * standard's, Claude Code's — and most repositories follow none of them exactly. This reads all of
 * them into one shape and says, per server, either where it is and how it is reached, or why it
 * cannot be installed on a server of ours. The sync script applies it when it writes the index;
 * the index tests apply it to fixtures; the install route trusts the index and never reads a
 * repository's `mcp.json` itself.
 *
 * FAIL CLOSED, PART BY PART. A server this cannot read is a part left out with a reason, not a
 * plugin refused: a plugin whose one stdio server is skipped still installs its skills. What is
 * never let through is a server whose address this deployment would not accept from an
 * administrator typing it (`customUrlRefusal`), a header carrying a literal credential (a secret
 * committed to a public repository is still a secret this index would be publishing), or a server
 * only Cursor's own proxies can reach.
 */

export type SkippedReason =
  /** `command` rather than `url`: a process to run, which a server of ours does not do. */
  | "stdio"
  /** Behind Cursor's or xAI's hosted proxies, which only their clients may call. */
  | "cursor-hosted"
  /** The address failed the floor an administrator's own URL has to pass. */
  | "url-refused"
  /** A placeholder in the address itself, which v1 does not fill. */
  | "url-variable"
  /** A credential-looking header with no placeholder: a secret written into the repository. */
  | "literal-credential"
  /** No `url` and no `command`: nothing to dial. */
  | "mcp-config-missing"
  /** A part this build does not install: rules, commands, agents, hooks. */
  | "unsupported-in-v1"
  /** The plugin's name, or this part's, gives no id this deployment can use. */
  | "no-id";

export type SkippedPart = {
  kind: "server" | "skill" | "rule" | "command" | "agent" | "hook";
  name: string;
  reason: SkippedReason;
};

/** A remote server as `mcp.json` described it, with every placeholder spelled `${NAME}`. */
export type ParsedServer = {
  name: string;
  url: string;
  transport: "http" | "sse";
  /** Header names to templates. Empty for a server that sends none. */
  headers: Record<string, string>;
  /** The variables the headers name, sorted, once each. */
  variables: string[];
  /** The OAuth client the plugin itself names, with its secret dropped on the floor. */
  staticClient: { clientId: string; scopes: string[] } | null;
};

export type ParsedMcpConfig = {
  servers: ParsedServer[];
  skipped: SkippedPart[];
};

/** Hosts a server of ours cannot reach: Cursor's REST proxies and xAI's connector gateway. */
const HOSTED_SUFFIXES = [".cursor.com", "cursor.com", ".grok.com", "grok.com"];

function isHostedElsewhere(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return HOSTED_SUFFIXES.some(
    (suffix) => host === suffix.replace(/^\./, "") || host.endsWith(suffix),
  );
}

/**
 * Every spelling of a placeholder, rewritten as `${NAME}`.
 *
 * `${env:NAME}` and `${input:NAME}` are Cursor's and VS Code's, `${NAME:-default}` is the shell's
 * (Zoom's plugin uses it), `${NAME}` is the plugin standard's. A name that is not upper-case
 * identifier-shaped is left as it was, which the caller then reads as a literal.
 */
export function normalisePlaceholders(value: string): string {
  return value.replaceAll(
    /\$\{(?:env:|input:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g,
    (whole, name: string) => (VARIABLE_NAME.test(name) ? `\${${name}}` : whole),
  );
}

const hasPlaceholder = (value: string) =>
  /\$\{[A-Z][A-Z0-9_]{0,63}\}/.test(value);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The map of servers out of whatever the file held.
 *
 * `{ mcpServers: { … } }` is every documented dialect. The bare form — `{ notion: { url } }` with
 * no wrapper, which Notion's own plugin ships — is accepted when there is no `mcpServers` key and
 * every top-level value looks like a server (an object with a `url` or a `command`).
 */
export function serverMapOf(parsed: unknown): Record<string, unknown> | null {
  const root = record(parsed);
  if (!root) return null;
  const wrapped = record(root.mcpServers);
  if (wrapped) return wrapped;
  if ("mcpServers" in root) return null;
  const entries = Object.entries(root);
  if (entries.length === 0) return null;
  const everyValueIsAServer = entries.every(([, value]) => {
    const candidate = record(value);
    return (
      candidate !== null &&
      (typeof candidate.url === "string" ||
        typeof candidate.command === "string")
    );
  });
  return everyValueIsAServer ? root : null;
}

function transportOf(type: unknown): "http" | "sse" {
  return typeof type === "string" && type.toLowerCase() === "sse"
    ? "sse"
    : "http";
}

function scopesOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (scope): scope is string => typeof scope === "string" && scope !== "",
    );
  }
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

/** Reads one `mcp.json` (already parsed) into servers and skipped parts. */
export function parseMcpConfig(parsed: unknown): ParsedMcpConfig {
  const servers: ParsedServer[] = [];
  const skipped: SkippedPart[] = [];
  const map = serverMapOf(parsed);
  if (!map) return { servers, skipped };

  for (const [name, raw] of Object.entries(map)) {
    const server = record(raw);
    if (!server) {
      skipped.push({ kind: "server", name, reason: "mcp-config-missing" });
      continue;
    }
    if (typeof server.command === "string") {
      skipped.push({ kind: "server", name, reason: "stdio" });
      continue;
    }
    if (typeof server.url !== "string" || !server.url.trim()) {
      skipped.push({ kind: "server", name, reason: "mcp-config-missing" });
      continue;
    }

    const url = normalisePlaceholders(server.url.trim());
    if (hasPlaceholder(url)) {
      skipped.push({ kind: "server", name, reason: "url-variable" });
      continue;
    }
    if (customUrlRefusal(url) !== null) {
      skipped.push({ kind: "server", name, reason: "url-refused" });
      continue;
    }
    if (isHostedElsewhere(new URL(url).hostname)) {
      skipped.push({ kind: "server", name, reason: "cursor-hosted" });
      continue;
    }

    const headers: Record<string, string> = {};
    let literalCredential = false;
    for (const [header, value] of Object.entries(
      record(server.headers) ?? {},
    )) {
      if (typeof value !== "string") continue;
      const template = normalisePlaceholders(value).replaceAll(/[\r\n]+/g, "");
      if (!HEADER_NAME.test(header)) continue;
      if (!hasPlaceholder(template) && readsAsCredential(header)) {
        literalCredential = true;
        break;
      }
      headers[header] = template;
    }
    if (literalCredential) {
      skipped.push({ kind: "server", name, reason: "literal-credential" });
      continue;
    }

    const auth = record(server.auth);
    const clientId =
      typeof auth?.CLIENT_ID === "string" ? auth.CLIENT_ID : null;
    // `CLIENT_SECRET` is read by nobody: a secret in a public repository is not one this index
    // will carry, and the client it belongs to is registered to another product's redirect anyway.

    const variables = [
      ...new Set(
        Object.values(headers).flatMap((template) =>
          [...template.matchAll(/\$\{([A-Z][A-Z0-9_]{0,63})\}/g)].map(
            (match) => match[1] ?? "",
          ),
        ),
      ),
    ]
      .filter(Boolean)
      .sort();

    servers.push({
      name,
      url,
      transport: transportOf(server.type),
      headers,
      variables,
      staticClient:
        clientId && !hasPlaceholder(clientId)
          ? { clientId, scopes: scopesOf(auth?.scopes) }
          : null,
    });
  }

  return { servers, skipped };
}
