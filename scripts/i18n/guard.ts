/**
 * English a person would see that does not go through a translation, per file.
 *
 *     bun scripts/i18n/guard.ts                   # counts per file, largest first
 *     bun scripts/i18n/guard.ts app/src/components/app-sidebar   # every hit under a path
 *     bun scripts/i18n/guard.ts --mark <paths>    # list the files under <paths> that reached zero
 *                                                 # in translated.json
 *
 * `translated.json` lists the files that are fully translated; `app/tests/i18n-catalogs.test.ts`
 * fails when one of them gains untranslated English or a key without Greek, which is what catches a
 * regression, including one an upstream merge brings back. A file joins the list with `--mark` once
 * it reaches zero, and the list never shrinks. When every file is on it, the test turns into "no file
 * anywhere has untranslated English".
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { scanApp, translatedFiles } from "./source";

const args = process.argv.slice(2);
const { untranslated } = scanApp();

if (args.includes("--mark")) {
  // Only files somebody has gone through: a file the guard finds nothing in may still build its
  // English in code where the guard cannot see it, so reaching zero alone is not "translated".
  const prefixes = args.filter((arg) => arg !== "--mark");
  if (!prefixes.length) throw new Error("Name the files or folders to mark.");
  const { appSourceFiles } = await import("./source");
  const translated = new Set(translatedFiles());
  for (const file of appSourceFiles()) {
    if (!prefixes.some((prefix) => file.startsWith(prefix))) continue;
    if (untranslated.has(file))
      console.log(`not yet: ${file} (${untranslated.get(file)?.length})`);
    else translated.add(file);
  }
  writeFileSync(
    path.join(import.meta.dir, "translated.json"),
    `${JSON.stringify([...translated].sort(), null, 2)}\n`,
  );
  console.log(`${translated.size} files marked translated`);
} else if (args.length) {
  for (const [file, hits] of untranslated) {
    if (!args.some((prefix) => file.startsWith(prefix))) continue;
    for (const hit of hits)
      console.log(`${file}:${hit.line}\t${hit.where}\t${hit.text}`);
  }
} else {
  const rows = [...untranslated].sort((a, b) => b[1].length - a[1].length);
  let total = 0;
  for (const [file, hits] of rows) {
    total += hits.length;
    console.log(`${String(hits.length).padStart(4)}  ${file}`);
  }
  console.log(`${total} untranslated in ${rows.length} files`);
}
