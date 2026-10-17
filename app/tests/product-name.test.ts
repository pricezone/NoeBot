import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import { ROOT } from "../../scripts/i18n/source";

/**
 * The product is Noë Bot, everywhere: in what a person reads, English and Greek, in the plugin
 * descriptions the Marketplace shows, in the docs, and in the comments that explain the code.
 *
 * Earlier design rounds copied another assistant's interface and called the product by that
 * assistant's name in places, so this reads every tracked file and fails on the old name in any
 * spelling: two words, run together, hyphenated, underscored, or broken across a comment's lines.
 * It is spelled out in no source here, this file included, so the pattern below is the only way to
 * say it. That assistant's maker, model and voice ("Grok Voice", `grok-4`, `grok.com`) are other
 * words and do not match.
 *
 * The vendored Marketplace index is held too. Its descriptions are plugin authors' words, which the
 * sync script rewrites at sync time (`server/src/plugins/rebrand.ts`); a hand edit or a sweep that
 * skipped the rewrite fails here.
 */
const OLD_NAME = /\bgrok(?:[\s_-]|\s*(?:\*|\/\/|#)\s*)?bots?\b/gi;
/** The same pattern for one yes-or-no answer: a global pattern carries state between tests. */
const NAMES_IT = new RegExp(OLD_NAME.source, "i");

/**
 * What still matches on purpose: values other systems define, which this repository quotes rather
 * than writes. Each names the file, the exact text and why it stays.
 */
const KEPT: { file: string; text: string; why: string }[] = [
  {
    file: "server/scripts/sync-plugin-index.ts",
    text: `clients.${"grok"}bot`,
    why: "Cursor's API field for that client's minimum version, read from its index",
  },
];

/** Never text worth reading, and some of it large. */
const BINARY =
  /\.(?:png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|mp3|mp4|wav|webm|zip|gz|pdf)$/i;

/** Every tracked file; a directory walk when there is no git (a source archive, say). */
function trackedFiles(): string[] {
  const git = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  if (git.exitCode === 0) {
    return git.stdout.toString().split("\0").filter(Boolean).sort();
  }
  const skipped =
    /(?:^|\/)(?:node_modules|dist|build|target|\.git|\.output|\.turbo)\//;
  return [...new Glob("**/*").scanSync({ cwd: ROOT, dot: true })]
    .filter((file) => !skipped.test(file))
    .sort();
}

function readText(file: string): string | null {
  try {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    return text.includes("\0") ? null : text;
  } catch {
    // Deleted in the working tree but still tracked, or a symlink to a directory.
    return null;
  }
}

const files = trackedFiles().filter((file) => !BINARY.test(file));

describe("the product's name", () => {
  test("the scan reads the repository, the vendored index and the Greek included", () => {
    expect(files.length).toBeGreaterThan(1000);
    for (const file of [
      "server/src/plugins/cursor-index.json",
      "app/src/locales/el/common.json",
      "docs/README.md",
    ]) {
      expect(files).toContain(file);
    }
  });

  test("no tracked file calls the product by the old name", () => {
    const found: string[] = [];
    for (const file of files) {
      let text = readText(file);
      if (text === null) continue;
      for (const kept of KEPT) {
        // Blanked to the same length, so the line numbers of anything else stay right.
        if (kept.file === file)
          text = text.replaceAll(kept.text, " ".repeat(kept.text.length));
      }
      for (const match of text.matchAll(OLD_NAME)) {
        const line = text.slice(0, match.index).split("\n").length;
        found.push(`${file}:${line}: ${match[0].replace(/\s+/g, " ")}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("everything kept is still there, so the list cannot outlive its reasons", () => {
    for (const kept of KEPT) {
      expect(readText(kept.file) ?? "").toContain(kept.text);
      expect(kept.text).toMatch(NAMES_IT);
    }
  });

  test("the pattern catches every spelling, and only the name", () => {
    const old = "grok";
    for (const spelling of [
      `${old} bot`,
      `${old.toUpperCase()} BOT`,
      `${old}Bot's`,
      `${old}-bot`,
      `${old}_bot`,
      `the way ${old}\n * Bot's settings do`,
      `like ${old}\n  // Bot`,
    ]) {
      expect(spelling).toMatch(NAMES_IT);
    }
    for (const other of [
      `${old} Voice`,
      `${old}-4.7`,
      `connectors-gateway.${old}.com`,
      `n${old} bot`,
      `${old}'s bottom sheet`,
      `${old} bottom`,
    ]) {
      expect(other).not.toMatch(NAMES_IT);
    }
  });
});
