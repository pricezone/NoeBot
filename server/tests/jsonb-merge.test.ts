import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Merging into a jsonb column takes the object, never its JSON text.
 *
 * Bun's driver binds a JS string as a jsonb STRING, so `payload || ${JSON.stringify(x)}::jsonb`
 * appends a string element and turns the object into an array. Measured against Postgres 16: the
 * decision records (approvals/decisions.ts) and the follow-ups (agents/wake-up.ts) were both written
 * that way. Passing the object (`${x}::jsonb`) merges it.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

test("no jsonb merge binds JSON text where the object belongs", () => {
  const root = join(import.meta.dir, "..", "src");
  const offenders = sources(root).filter((file) =>
    /JSON\.stringify\([^`]*?\)\}::jsonb/.test(readFileSync(file, "utf8")),
  );
  expect(offenders).toEqual([]);
});
