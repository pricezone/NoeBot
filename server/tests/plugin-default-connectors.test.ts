import { describe, expect, test } from "bun:test";
import {
  BEARER_KEY_ID,
  type DefaultConnectorDeps,
  offerDefaultConnectors,
} from "../src/plugins/default-connectors";

/**
 * Apps a deployment offers to every Bot from its first boot.
 *
 * Driven with a stub store and vault, because what is under test is the decision per key: which
 * kinds are taken, what is left alone, and that one vendor's trouble never stops the others.
 */

function fixture(
  overrides: Partial<DefaultConnectorDeps> & {
    existing?: string[];
    /** Who added each existing row; a row not named here was added by an administrator. */
    owners?: Record<string, string>;
    vault?: { id: string; plaintext: string } | null;
    failing?: string[];
  } = {},
) {
  const added: { key: string; credentialId?: string; offered?: boolean }[] = [];
  const existing = new Set(overrides.existing ?? []);
  const failing = new Set(overrides.failing ?? []);
  let vault = overrides.vault ?? null;
  const owners = overrides.owners ?? {};
  const created: string[] = [];
  const rotated: string[] = [];
  const removed: string[] = [];
  const warnings: { key: string; reason: string }[] = [];
  const deps: DefaultConnectorDeps = {
    store: {
      serverExists: async (id) => existing.has(id),
      addServer: async (input) => {
        if (failing.has(input.key)) throw new Error("vendor down");
        added.push({
          key: input.key,
          credentialId: input.credentialId,
          offered: input.offeredToAllBots,
        });
        existing.add(input.key);
      },
      serverAddedBy: async (id) =>
        existing.has(id) ? (owners[id] ?? "admin@example.com") : undefined,
      removeServer: async (id) => {
        removed.push(id);
        existing.delete(id);
      },
    },
    credentials: {
      findLiveByKey: async () => (vault ? { id: vault.id } : null),
      readPlaintext: async (id) =>
        vault && vault.id === id ? vault.plaintext : null,
      create: async (input) => {
        created.push(input.plaintext);
        vault = { id: "cred-1", plaintext: input.plaintext };
        return { id: "cred-1" };
      },
      rotate: async (input) => {
        rotated.push(input.previousCredentialId);
        vault = { id: "cred-2", plaintext: input.plaintext };
        return { id: "cred-2" };
      },
    },
    keys: overrides.keys ?? [],
    bearers: overrides.bearers ?? {},
    by: "deployment",
    warn: (detail) => warnings.push(detail),
  };
  return {
    deps,
    added,
    created,
    rotated,
    removed,
    warnings,
    vault: () => vault,
  };
}

describe("default connectors", () => {
  test("adds the apps that need no key, offered to every Bot, and leaves one that exists alone", async () => {
    const f = fixture({
      keys: ["parallel", "routines"],
      existing: ["routines"],
    });
    const outcomes = await offerDefaultConnectors(f.deps);
    expect(f.added).toEqual([
      { key: "parallel", credentialId: undefined, offered: true },
    ]);
    expect(outcomes).toEqual([
      { key: "parallel", outcome: "added" },
      { key: "routines", outcome: "present" },
    ]);
  });

  test("skips what it cannot take, with a reason, and goes on", async () => {
    const f = fixture({
      keys: [
        "nonsense",
        "parallel-oauth",
        "parallel-authenticated",
        "routines",
      ],
    });
    const outcomes = await offerDefaultConnectors(f.deps);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "added",
    ]);
    expect(f.warnings.map((warning) => warning.key)).toEqual([
      "nonsense",
      "parallel-oauth",
      "parallel-authenticated",
    ]);
  });

  test("keeps a deployment's bearer in the vault, once, and rotates it when it changes", async () => {
    const first = fixture({
      keys: ["parallel-authenticated"],
      bearers: { "parallel-authenticated": "pk-one" },
    });
    expect(await offerDefaultConnectors(first.deps)).toEqual([
      { key: "parallel-authenticated", outcome: "added" },
    ]);
    expect(first.created).toEqual(["pk-one"]);
    expect(first.added).toEqual([
      { key: "parallel-authenticated", credentialId: "cred-1", offered: true },
    ]);

    // The next boot, same key: nothing is written.
    const again = fixture({
      keys: ["parallel-authenticated"],
      bearers: { "parallel-authenticated": "pk-one" },
      existing: ["parallel-authenticated"],
      vault: { id: "cred-1", plaintext: "pk-one" },
    });
    expect(await offerDefaultConnectors(again.deps)).toEqual([
      { key: "parallel-authenticated", outcome: "present" },
    ]);
    expect(again.created).toEqual([]);
    expect(again.rotated).toEqual([]);

    // A changed key rotates the row in place.
    const changed = fixture({
      keys: ["parallel-authenticated"],
      bearers: { "parallel-authenticated": "pk-two" },
      existing: ["parallel-authenticated"],
      vault: { id: "cred-1", plaintext: "pk-one" },
    });
    expect(await offerDefaultConnectors(changed.deps)).toEqual([
      { key: "parallel-authenticated", outcome: "rotated" },
    ]);
    expect(changed.rotated).toEqual(["cred-1"]);
    expect(changed.vault()).toEqual({ id: "cred-2", plaintext: "pk-two" });
  });

  test("a vendor that cannot be reached is a warning for that key only", async () => {
    const f = fixture({
      keys: ["parallel", "routines"],
      failing: ["parallel"],
    });
    const outcomes = await offerDefaultConnectors(f.deps);
    expect(outcomes).toEqual([
      { key: "parallel", outcome: "skipped", reason: "vendor down" },
      { key: "routines", outcome: "added" },
    ]);
  });

  test("retires the anonymous search it seeded once the deployment's key arrives", async () => {
    const f = fixture({
      keys: ["parallel-authenticated", "routines"],
      bearers: { "parallel-authenticated": "pk-one" },
      existing: ["parallel", "routines"],
      owners: { parallel: "deployment", routines: "deployment" },
    });
    expect(await offerDefaultConnectors(f.deps)).toEqual([
      { key: "parallel-authenticated", outcome: "added" },
      { key: "routines", outcome: "present" },
      { key: "parallel", outcome: "retired" },
    ]);
    expect(f.removed).toEqual(["parallel"]);
  });

  test("leaves an anonymous search an administrator added, or one the deployment still asks for", async () => {
    const byAdmin = fixture({
      keys: ["parallel-authenticated"],
      bearers: { "parallel-authenticated": "pk-one" },
      existing: ["parallel"],
    });
    await offerDefaultConnectors(byAdmin.deps);
    expect(byAdmin.removed).toEqual([]);

    const both = fixture({
      keys: ["parallel", "parallel-authenticated"],
      bearers: { "parallel-authenticated": "pk-one" },
      existing: ["parallel"],
      owners: { parallel: "deployment" },
    });
    await offerDefaultConnectors(both.deps);
    expect(both.removed).toEqual([]);
  });

  test("keeps the anonymous search when the key it would give way to is not live", async () => {
    const f = fixture({
      keys: ["parallel-authenticated"],
      existing: ["parallel"],
      owners: { parallel: "deployment" },
    });
    await offerDefaultConnectors(f.deps);
    expect(f.removed).toEqual([]);
  });

  test("files a bearer under one fixed key id", () => {
    expect(BEARER_KEY_ID).toBe("env");
  });
});
