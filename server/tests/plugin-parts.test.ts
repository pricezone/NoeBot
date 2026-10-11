// biome-ignore-all lint/suspicious/noTemplateCurlyInString: a plugin's `${NAME}` placeholder is data here, not a template.
import { describe, expect, test } from "bun:test";
import {
  fetchGithubRaw,
  githubRepositoryOf,
  joinRepositoryPath,
  rawUrlFor,
} from "../src/plugins/github-raw";
import { placeholdersIn, renderHeaders } from "../src/plugins/header-template";
import { parseSkillMarkdown } from "../src/plugins/skill-md";

/**
 * The three pure pieces an install is made of: the templates a person's token is rendered into,
 * the `SKILL.md` a skill is read out of, and the one fetch that reads it from GitHub.
 */

describe("header templates", () => {
  test("names every variable once, sorted", () => {
    expect(
      placeholdersIn({
        Authorization: "Bearer ${TREG_TOKEN}",
        "X-Org": "${ORG_ID}",
        "X-Again": "${TREG_TOKEN}",
      }),
    ).toEqual(["ORG_ID", "TREG_TOKEN"]);
    expect(placeholdersIn({ Accept: "application/json" })).toEqual([]);
  });

  test("renders every placeholder from the person's values, and refuses a hole", () => {
    expect(
      renderHeaders(
        { Authorization: "Bearer ${TREG_TOKEN}", Accept: "application/json" },
        { TREG_TOKEN: "abc" },
      ),
    ).toEqual({
      ok: true,
      headers: { Authorization: "Bearer abc", Accept: "application/json" },
    });
    expect(
      renderHeaders(
        { Authorization: "Bearer ${TREG_TOKEN}" },
        { TREG_TOKEN: "" },
      ),
    ).toEqual({ ok: false, missing: ["TREG_TOKEN"], invalid: [] });
  });

  test("a line break in a value is cut, and a header that is not a header name refuses", () => {
    expect(
      renderHeaders(
        { Authorization: "Bearer ${T}" },
        { T: "abc\r\nX-Evil: 1" },
      ),
    ).toEqual({ ok: true, headers: { Authorization: "Bearer abcX-Evil: 1" } });
    expect(renderHeaders({ "Bad Header": "${T}" }, { T: "x" })).toEqual({
      ok: false,
      missing: [],
      invalid: ["Bad Header"],
    });
  });
});

describe("SKILL.md", () => {
  test("frontmatter gives the name and description; the body is the instructions", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: Deep research\ndescription: Exhaustive reports.\ncompatibility: Requires parallel-cli.\n---\n\n# Deep research\n\nDo the thing.\n",
    );
    expect(parsed).toEqual({
      name: "Deep research",
      description: "Exhaustive reports.",
      body: "# Deep research\n\nDo the thing.",
    });
  });

  test("no frontmatter, or frontmatter that is not YAML, is all body", () => {
    expect(parseSkillMarkdown("Just instructions.")).toEqual({
      body: "Just instructions.",
    });
    expect(parseSkillMarkdown("---\n: : :\n  - [\n---\nBody")).toEqual({
      body: "Body",
    });
    expect(parseSkillMarkdown("---\n- a list\n---\nBody")).toEqual({
      body: "Body",
    });
    expect(parseSkillMarkdown("﻿---\nname: x\n---\n")).toEqual({
      name: "x",
      body: "",
    });
  });
});

describe("one file out of GitHub", () => {
  test("a plugin's git url is an owner and a repository, or nothing", () => {
    expect(
      githubRepositoryOf(
        "https://github.com/parallel-web/parallel-cursor-plugin",
      ),
    ).toEqual({
      owner: "parallel-web",
      repo: "parallel-cursor-plugin",
    });
    expect(githubRepositoryOf("https://github.com/x/y.git")).toEqual({
      owner: "x",
      repo: "y",
    });
    expect(githubRepositoryOf("https://gitlab.com/x/y")).toBeNull();
    expect(githubRepositoryOf("http://github.com/x/y")).toBeNull();
    expect(githubRepositoryOf("https://github.com/x")).toBeNull();
    expect(githubRepositoryOf("not a url")).toBeNull();
  });

  test("the address is the raw host, the commit and plain segments, and nothing else", () => {
    const ref = "b0fd7db38cf7398d46bc68dd631af9ec285bc55f";
    expect(
      rawUrlFor({ owner: "o", repo: "r", ref, path: "skills/a b/SKILL.md" }),
    ).toBe(
      `https://raw.githubusercontent.com/o/r/${ref}/skills/a%20b/SKILL.md`,
    );
    expect(
      rawUrlFor({ owner: "o", repo: "r", ref: "main", path: "x" }),
    ).toBeNull();
    expect(rawUrlFor({ owner: "o", repo: "r", ref, path: "../x" })).toBeNull();
    expect(rawUrlFor({ owner: "o", repo: "r", ref, path: "a//b" })).toBeNull();
    expect(rawUrlFor({ owner: "o", repo: "r", ref, path: "a?b" })).toBeNull();
    expect(rawUrlFor({ owner: "o/x", repo: "r", ref, path: "a" })).toBeNull();
    expect(
      joinRepositoryPath("plugins/treg", "/skills/", "treg", "SKILL.md"),
    ).toBe("plugins/treg/skills/treg/SKILL.md");
  });

  test("reads a body, and refuses a redirect, a missing file and an oversized one", async () => {
    const ref = "a".repeat(40);
    const file = { owner: "o", repo: "r", ref, path: "SKILL.md" };
    const answering = (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ) =>
      (async () =>
        new Response(body, { status, headers })) as unknown as typeof fetch;

    expect(
      await fetchGithubRaw(file, { fetch: answering(200, "hello") }),
    ).toEqual({
      ok: true,
      text: "hello",
    });
    expect(await fetchGithubRaw(file, { fetch: answering(404, "") })).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(
      await fetchGithubRaw(file, {
        fetch: answering(302, "", { location: "https://elsewhere.example/" }),
      }),
    ).toEqual({ ok: false, reason: "refused" });
    expect(
      await fetchGithubRaw(file, {
        fetch: answering(200, "x".repeat(50), {}),
        maxBytes: 10,
      }),
    ).toEqual({ ok: false, reason: "too-large" });
    expect(
      await fetchGithubRaw(file, {
        fetch: (async () => {
          throw new TypeError("unreachable");
        }) as unknown as typeof fetch,
      }),
    ).toEqual({ ok: false, reason: "unreachable" });
    expect(
      await fetchGithubRaw(
        { ...file, ref: "main" },
        { fetch: answering(200, "x") },
      ),
    ).toEqual({ ok: false, reason: "refused" });
  });
});
