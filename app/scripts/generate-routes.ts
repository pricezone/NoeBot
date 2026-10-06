/**
 * Regenerate app/src/routeTree.gen.ts from app/src/routes without starting Vite.
 *
 * The Vite plugin regenerates the tree on `dev` and `build`; a route file added or moved
 * between those runs leaves the committed tree stale, and `tsc` then reports the route id as
 * missing. This runs the same generator the plugin uses, with the same settings as
 * app/vite.config.ts, from the command line: `bun app/scripts/generate-routes.ts`.
 *
 * The generator is a dependency of the plugin rather than of the app, so Bun's isolated
 * install keeps it under node_modules/.bun and it is found there by name rather than linked.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const app = resolve(import.meta.dir, "..");
const repo = resolve(app, "..");
const store = resolve(repo, "node_modules/.bun");
const entry = readdirSync(store).find((name) =>
  name.startsWith("@tanstack+router-generator@"),
);
if (!entry) {
  throw new Error(
    "@tanstack/router-generator is not installed; run `bun install` at the repo root.",
  );
}

const { Generator, getConfig } = (await import(
  pathToFileURL(
    resolve(
      store,
      entry,
      "node_modules/@tanstack/router-generator/dist/esm/index.js",
    ),
  ).href
)) as typeof import("@tanstack/router-generator");

const config = getConfig(
  {
    target: "react",
    routesDirectory: resolve(app, "src/routes"),
    generatedRouteTree: resolve(app, "src/routeTree.gen.ts"),
    autoCodeSplitting: true,
  },
  app,
);

await new Generator({ config, root: app }).run();
console.info("routeTree.gen.ts regenerated");
