/**
 * What the Greek catalogs are missing, and what they hold that nothing asks for any more.
 *
 *     bun scripts/i18n/extract.ts                 # summary per namespace
 *     bun scripts/i18n/extract.ts --missing       # every missing entry, with where it is used
 *     bun scripts/i18n/extract.ts --missing --ns settings --json
 *     bun scripts/i18n/extract.ts --stale         # Greek entries no code asks for
 *
 * The keys are read straight from the source (`scan.ts`), so nothing generated is committed and
 * nothing goes stale between a code change and a catalog change. A missing entry reads as English in
 * the app; `app/tests/i18n-catalogs.test.ts` is what holds translated files to having none.
 */
import { catalogEntriesFor, greekCatalogs, scanApp } from "./source";

const args = process.argv.slice(2);
const only = args.includes("--ns") ? args[args.indexOf("--ns") + 1] : undefined;
const asJson = args.includes("--json");

const { keys } = scanApp();
const catalogs = greekCatalogs();

type Missing = { namespace: string; entry: string; at: string[] };
const missing = new Map<string, Missing>();
const wanted = new Map<string, Set<string>>();
for (const key of keys) {
  if (only && key.namespace !== only) continue;
  const catalog = catalogs.get(key.namespace) ?? {};
  for (const entry of catalogEntriesFor(key)) {
    const names = wanted.get(key.namespace) ?? new Set<string>();
    names.add(entry);
    wanted.set(key.namespace, names);
    // The shell's catalog answers for every namespace too (`fallbackNS`).
    if (catalog[entry] || catalogs.get("common")?.[entry]) continue;
    const id = `${key.namespace}\u0000${entry}`;
    const known = missing.get(id) ?? {
      namespace: key.namespace,
      entry,
      at: [],
    };
    known.at.push(`${key.file}:${key.line}`);
    missing.set(id, known);
  }
}

const stale: { namespace: string; entry: string }[] = [];
for (const [namespace, catalog] of catalogs) {
  if (only && namespace !== only) continue;
  const used = new Set<string>();
  for (const names of wanted.values()) for (const name of names) used.add(name);
  for (const entry of Object.keys(catalog))
    if (!used.has(entry)) stale.push({ namespace, entry });
}

if (args.includes("--missing")) {
  const list = [...missing.values()];
  if (asJson) console.log(JSON.stringify(list, null, 2));
  else
    for (const item of list)
      console.log(`${item.namespace}\t${item.entry}\t${item.at.join(", ")}`);
} else if (args.includes("--stale")) {
  if (asJson) console.log(JSON.stringify(stale, null, 2));
  else
    for (const item of stale) console.log(`${item.namespace}\t${item.entry}`);
} else {
  const namespaces = new Set([...wanted.keys(), ...catalogs.keys()]);
  for (const namespace of [...namespaces].sort()) {
    const total = wanted.get(namespace)?.size ?? 0;
    const gaps = [...missing.values()].filter(
      (item) => item.namespace === namespace,
    ).length;
    const unused = stale.filter((item) => item.namespace === namespace).length;
    console.log(
      `${namespace.padEnd(10)} ${String(total).padStart(5)} entries  ${String(gaps).padStart(5)} missing  ${String(unused).padStart(4)} stale`,
    );
  }
}
