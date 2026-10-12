import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { createPluginStore } from "../src/plugins/store";
import { testDatabaseUrl } from "./support/database";

/**
 * A burst of the Marketplace's reads must leave every pooled connection usable.
 *
 * THE INCIDENT THIS GUARDS. On 2026-10-12 a deployment on Bun 1.3.14 lost its Marketplace: the
 * Agents tab's `/api/bot-templates` (then twenty-eight `serverExists` and fourteen `listPlugins`
 * per request, all at once) opened beside `/api/plugins` (`listServers` and `listSkills`) leaked
 * pooled connections. Postgres showed them idle at the last query they had answered; the runtime
 * never handed them out again; a few page loads later the pool was gone and every database route
 * hung until the client gave up. Plain bursts of a thousand queries, transactions, reserved
 * connections and distinct prepared statements did not reproduce it — this mix, through the real
 * store, did: round one is clean, round two loses most of the pool. Bun 1.4.2 answers both rounds
 * in under a second. The runtime is pinned (package.json, both Dockerfiles, CI); this is what says
 * so if a later runtime brings it back.
 *
 * The pool is the production one, ten connections, not the suite's two-connection TEST_POOL: the
 * leak is a property of the pool under contention, and a pool of two cannot show it.
 */

const database = createDatabase(testDatabaseUrl());
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    readSecret: async () => null,
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    updateSecret: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => new Date(),
  } as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }) as never,
});

afterAll(async () => {
  await database.$client.close({ timeout: 2 }).catch(() => undefined);
});

/** The value, or "timeout" when nothing came back in time — a hung query must not hang the suite. */
function settled(work: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
}

/**
 * How long ten concurrent sleeps take. On ten live connections they run together, in about the
 * sleep itself; on a pool that has lost most of its connections they queue, and on a pool that has
 * lost them all they never come back.
 */
async function tenSleeps(): Promise<{ ms: number; timeouts: number }> {
  const started = performance.now();
  const out = await Promise.all(
    Array.from({ length: 10 }, () =>
      settled(database.execute(sql`select pg_sleep(0.4)`), 15_000),
    ),
  );
  return {
    ms: performance.now() - started,
    timeouts: out.filter((value) => value === "timeout").length,
  };
}

describe("the Marketplace's reads in a burst", () => {
  test(
    "two rounds of the Agents tab beside the plugins page answer, and the pool is whole afterwards",
    async () => {
      // Opens the pool's connections, so the measurement after the burst is of the burst alone.
      const warm = await tenSleeps();
      expect(warm.timeouts).toBe(0);

      const actor = { id: "pool-burst-admin", isAdmin: true };
      const keys = Array.from({ length: 28 }, (_, index) => `app-${index % 20}`);
      for (const round of [1, 2]) {
        const calls = [
          ...Array.from({ length: 18 }, () => [
            ...keys.map((key) => settled(store.serverExists(key), 20_000)),
            ...Array.from({ length: 14 }, () =>
              settled(store.listPlugins(), 20_000),
            ),
          ]).flat(),
          ...Array.from({ length: 18 }, () => [
            settled(store.listServers(), 20_000),
            settled(store.listSkills(actor), 20_000),
          ]).flat(),
        ];
        const out = await Promise.all(calls);
        const timeouts = out.filter((value) => value === "timeout").length;
        expect(`round ${round}: ${timeouts} of ${out.length} timed out`).toBe(
          `round ${round}: 0 of ${out.length} timed out`,
        );
      }

      const after = await tenSleeps();
      expect(after.timeouts).toBe(0);
      // Ten live connections take one sleep; four would take three, and the leak took all ten.
      expect(after.ms).toBeLessThan(1_500);
    },
    120_000,
  );
});
