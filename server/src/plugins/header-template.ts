/**
 * Header templates: how a plugin server that takes a token in a header is told the token.
 *
 * A plugin's `mcp.json` says `"Authorization": "Bearer ${TREG_TOKEN}"`, and Cursor fills the
 * placeholder from a value an administrator typed once for the whole team. Here the value is one
 * person's own, held in the vault under their connection row, and rendered into the headers per
 * request — so the template is stored on the server row where anybody can read it, and the value
 * never is. These two functions are the only readers of a template.
 *
 * Pure, and strict in both directions: a placeholder with no value refuses the render rather than
 * sending a header with a hole in it, and a value with a line break in it is cut rather than sent,
 * because a line break inside a header is a second header.
 */

/** `${NAME}`: upper case, digits and underscores, the way a plugin's `variables` schema names them. */
export const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]{0,63})\}/g;

/** A header name as RFC 9110 spells a token, less the punctuation nobody uses in one. */
export const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** Every variable the templates name, once each, sorted — what a connect form asks for. */
export function placeholdersIn(
  templates: Readonly<Record<string, string>>,
): string[] {
  const names = new Set<string>();
  for (const template of Object.values(templates)) {
    for (const match of template.matchAll(PLACEHOLDER)) {
      const name = match[1];
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

export type RenderedHeaders =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; missing: string[]; invalid: string[] };

/**
 * The headers to send, with every placeholder filled from this person's values.
 *
 * `missing` names the placeholders the values do not cover; `invalid` names header names that are
 * not header names. Either refuses the whole render: a request with some of its headers is a
 * request the vendor refuses with a sentence about the wrong thing.
 */
export function renderHeaders(
  templates: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string>>,
): RenderedHeaders {
  const missing = placeholdersIn(templates).filter(
    (name) => typeof values[name] !== "string" || values[name] === "",
  );
  const invalid = Object.keys(templates).filter(
    (name) => !HEADER_NAME.test(name),
  );
  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, missing, invalid };
  }

  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(templates)) {
    headers[name] = template
      .replaceAll(PLACEHOLDER, (_, variable: string) => values[variable] ?? "")
      // A line break inside a header value is a second header: cut, never sent.
      .replaceAll(/[\r\n]+/g, "");
  }
  return { ok: true, headers };
}
