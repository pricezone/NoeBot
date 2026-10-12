import { catalogueEntry, serverCredentialKind } from "./catalogue";

/**
 * Apps a deployment offers to every Bot from its first boot, by its configuration.
 *
 * What pressing Enable on the Marketplace does (`POST /servers/:id/enable`), done by the deployment
 * for the keys `OPENBOT_DEFAULT_CONNECTORS` names, so a hosted instance searches the web and
 * schedules routines the moment it exists rather than after its owner finds the page. The same
 * rules as that route: an app needing no credential (`none`), one that runs in this process
 * (`builtin`), and, beyond what the route admits, one reached on a key this deployment holds
 * (`deployment-bearer`), whose key arrives in `connectorBearers` and is kept in the vault here.
 *
 * Idempotent, and an administrator's wishes survive it: a row that exists is left as it is (the
 * add never moves `offeredToAllBots` on an existing row, and an administrator who narrowed an app
 * to chosen Bots keeps it narrowed on every boot), a bearer that did not change is not rewritten,
 * and one that did is rotated in place so the row keeps pointing at a live credential. Every key is
 * tried on its own: a vendor that cannot be reached, or a key nobody has heard of, is a warning and
 * never a reason for the deployment not to start.
 */
export type DefaultConnectorDeps = {
  store: {
    serverExists(serverId: string): Promise<boolean>;
    addServer(input: {
      key: string;
      by: string;
      credentialId?: string;
      offeredToAllBots?: boolean;
    }): Promise<unknown>;
    /** Who added a server: undefined when there is no such row. */
    serverAddedBy(serverId: string): Promise<string | null | undefined>;
    removeServer(serverId: string, by: string): Promise<void>;
  };
  credentials: {
    findLiveByKey(key: {
      kind: "mcp";
      provider: string;
      keyId: string;
    }): Promise<{ id: string } | null>;
    /** The secret a live credential holds, decrypted; null when the row is gone. */
    readPlaintext(id: string): Promise<string | null>;
    create(input: {
      kind: "mcp";
      provider: string;
      keyId: string;
      metadata: Record<string, unknown>;
      plaintext: string;
    }): Promise<{ id: string }>;
    rotate(input: {
      kind: "mcp";
      provider: string;
      keyId: string;
      metadata: Record<string, unknown>;
      plaintext: string;
      previousCredentialId: string;
    }): Promise<{ id: string }>;
  };
  keys: readonly string[];
  bearers: Readonly<Record<string, string>>;
  /** Whose name the trail records for the add. */
  by: string;
  warn?: (detail: { key: string; reason: string }) => void;
};

/** The vault key one deployment-held bearer for a catalogue app lives under. */
export const BEARER_KEY_ID = "env";

export type DefaultConnectorOutcome = {
  key: string;
  outcome: "added" | "present" | "rotated" | "retired" | "skipped";
  reason?: string;
};

/**
 * Apps another one replaces once it is live. The same vendor's tools under two entries give a Bot
 * every search tool twice, so when a deployment that seeded anonymous Parallel later gains a key,
 * the anonymous entry goes. Only a row the deployment itself added: one an administrator added is
 * theirs to remove.
 */
const SUPERSEDES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "parallel-authenticated": Object.freeze(["parallel"]),
});

export async function offerDefaultConnectors(
  deps: DefaultConnectorDeps,
): Promise<DefaultConnectorOutcome[]> {
  const outcomes: DefaultConnectorOutcome[] = [];
  const skip = (key: string, reason: string) => {
    deps.warn?.({ key, reason });
    outcomes.push({ key, outcome: "skipped", reason });
  };
  for (const key of new Set(deps.keys)) {
    try {
      const entry = catalogueEntry(key);
      if (!entry) {
        skip(key, "not an app this deployment offers");
        continue;
      }
      if (entry.auth.kind === "user-oauth") {
        skip(key, "connected with a person's own account, not enabled");
        continue;
      }
      const kind = serverCredentialKind(entry);
      if (kind === null) {
        // `none` and `builtin`: what the Enable route admits.
        if (await deps.store.serverExists(key)) {
          outcomes.push({ key, outcome: "present" });
          continue;
        }
        await deps.store.addServer({
          key,
          by: deps.by,
          offeredToAllBots: true,
        });
        outcomes.push({ key, outcome: "added" });
        continue;
      }
      const bearer = deps.bearers[key];
      if (!bearer) {
        skip(
          key,
          "runs on a key this deployment holds, and none is configured",
        );
        continue;
      }
      const credential = await ensureBearer(deps, key, kind, bearer);
      if (await deps.store.serverExists(key)) {
        outcomes.push({
          key,
          outcome: credential.rotated ? "rotated" : "present",
        });
        continue;
      }
      await deps.store.addServer({
        key,
        by: deps.by,
        credentialId: credential.id,
        offeredToAllBots: true,
      });
      outcomes.push({ key, outcome: "added" });
    } catch (error) {
      skip(key, error instanceof Error ? error.message : String(error));
    }
  }
  const wanted = new Set(deps.keys);
  for (const { key, outcome } of [...outcomes]) {
    if (outcome === "skipped") continue;
    for (const older of SUPERSEDES[key] ?? []) {
      if (wanted.has(older)) continue;
      try {
        if ((await deps.store.serverAddedBy(older)) !== deps.by) continue;
        await deps.store.removeServer(older, deps.by);
        outcomes.push({ key: older, outcome: "retired" });
      } catch (error) {
        skip(older, error instanceof Error ? error.message : String(error));
      }
    }
  }
  return outcomes;
}

/**
 * The vault row for a deployment-held bearer, created the first time, rotated when the value in the
 * environment changed, and left alone otherwise. Rotation keeps the row's id the server row points
 * at, so nothing else has to be rewired when a key is replaced.
 */
async function ensureBearer(
  deps: DefaultConnectorDeps,
  key: string,
  kind: "mcp",
  bearer: string,
): Promise<{ id: string; rotated: boolean }> {
  const where = { kind, provider: key, keyId: BEARER_KEY_ID } as const;
  const metadata = { source: "environment" };
  const live = await deps.credentials.findLiveByKey(where);
  if (!live) {
    const created = await deps.credentials.create({
      ...where,
      metadata,
      plaintext: bearer,
    });
    return { id: created.id, rotated: false };
  }
  const current = await deps.credentials.readPlaintext(live.id);
  if (current === bearer) return { id: live.id, rotated: false };
  const rotated = await deps.credentials.rotate({
    ...where,
    metadata,
    plaintext: bearer,
    previousCredentialId: live.id,
  });
  return { id: rotated.id, rotated: true };
}
