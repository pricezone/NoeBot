import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import {
  type FoundKey,
  keysIn,
  parse,
  type Untranslated,
  untranslatedIn,
} from "./scan";

/**
 * The app's source as the i18n tools read it: every `.ts`/`.tsx` under `app/src` except what is
 * generated, keyed by its path from the repository root.
 */
export const ROOT = path.resolve(import.meta.dir, "../..");

const GENERATED = [/routeTree\.gen\.ts$/, /\/lib\/generated\//];

export function appSourceFiles(): string[] {
  const files: string[] = [];
  for (const file of new Glob("app/src/**/*.{ts,tsx}").scanSync(ROOT)) {
    if (GENERATED.some((pattern) => pattern.test(file))) continue;
    files.push(file);
  }
  return files.sort();
}

export function scanApp(): {
  keys: FoundKey[];
  untranslated: Map<string, Untranslated[]>;
} {
  const keys: FoundKey[] = [];
  const untranslated = new Map<string, Untranslated[]>();
  for (const file of appSourceFiles()) {
    const source = parse(file, readFileSync(path.join(ROOT, file), "utf8"));
    keys.push(...keysIn(file, source));
    const raw = untranslatedIn(file, source);
    if (raw.length) untranslated.set(file, raw);
  }
  return { keys, untranslated };
}

/** The Greek catalogs, by namespace. */
export function greekCatalogs(): Map<string, Record<string, string>> {
  const catalogs = new Map<string, Record<string, string>>();
  for (const file of new Glob("app/src/locales/el/*.json").scanSync(ROOT)) {
    catalogs.set(
      path.basename(file, ".json"),
      JSON.parse(readFileSync(path.join(ROOT, file), "utf8")),
    );
  }
  return catalogs;
}

/** The files that are fully translated, and must stay so. See `translated.json`. */
export function translatedFiles(): string[] {
  return JSON.parse(
    readFileSync(path.join(import.meta.dir, "translated.json"), "utf8"),
  ) as string[];
}

/** Catalog entries a key needs: one, or `_one` and `_other` for a plural, under its context. */
export function catalogEntriesFor(key: FoundKey): string[] {
  const base = key.context ? `${key.key}_${key.context}` : key.key;
  return key.plural ? [`${base}_one`, `${base}_other`] : [base];
}
