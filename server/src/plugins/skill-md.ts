import { parse } from "yaml";

/**
 * A plugin's `skills/<name>/SKILL.md`, read into the three fields a skill row has.
 *
 * The Agent Skills layout: an optional YAML frontmatter between two `---` lines carrying `name`
 * and `description` (and whatever else the author liked — `compatibility`, `allowed-tools`,
 * `metadata` — which is read and dropped), then the instructions as Markdown. A file with no
 * frontmatter, or one whose frontmatter is not YAML, is all body: the caller has the skill's
 * directory name to title it by, and a parse failure in somebody else's frontmatter is not a
 * reason to install nothing.
 *
 * Pure, so the route that fetches the file and the test that feeds it a string share it.
 */
export type SkillMarkdown = {
  name?: string;
  description?: string;
  /** The instructions, trimmed. Empty when the file was only frontmatter. */
  body: string;
};

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseSkillMarkdown(text: string): SkillMarkdown {
  const source = text.replace(/^﻿/, "");
  const match = FRONTMATTER.exec(source);
  if (!match) return { body: source.trim() };

  const body = source.slice(match[0].length).trim();
  let parsed: unknown;
  try {
    parsed = parse(match[1] ?? "");
  } catch {
    return { body };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { body };
  }
  const fields = parsed as Record<string, unknown>;
  const text_ = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    ...(text_(fields.name) ? { name: text_(fields.name) } : {}),
    ...(text_(fields.description)
      ? { description: text_(fields.description) }
      : {}),
    body,
  };
}
