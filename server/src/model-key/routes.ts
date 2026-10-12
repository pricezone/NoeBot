import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { RuntimeModel } from "../copilot";
import type { CredentialStore } from "../credentials";

/**
 * What the Keys page says about the model the Bots run on.
 *
 * The key itself is resolved per call by `resolveModelApiKey` (`credentials.ts`): the live
 * `credentials` row for `(kind "model", provider, keyId)` first, the environment's variable
 * otherwise. So replacing it is a write to the credential vault — `POST /api/admin/credentials`
 * with `kind: "model"`, which rotates in place — and takes effect on the next call, with no
 * restart. This route is the read that tells the page which of the two is in force; it never
 * carries the secret, and the source is told to administrators alone, since whether a key sits in
 * the vault or the environment is the deployment's business, not every member's.
 *
 * On a METERED deployment the model is reached through the platform's gateway, which
 * authenticates the deployment's own token, so a personal key must not be offered there: the
 * page shows "HyperNoesis API" and the billing link instead. `metered` is what says so.
 */
export type ModelKeyRouteDeps = {
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  model: Pick<RuntimeModel, "provider" | "defaultModel">;
  /** The credential key id the runtime resolves the model key under (the package's `credential_secret_ref`). */
  keyId: string;
  metered: boolean;
  billingUrl: string | null;
  store: Pick<CredentialStore, "findLiveByKey">;
  environment: Record<string, string | undefined>;
};

export type ModelKeySource = "vault" | "environment" | "none";

export function createModelKeyRoutes(deps: ModelKeyRouteDeps) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const environmentVariable =
    deps.model.provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : "OPENAI_API_KEY";

  routes.get("/", deps.requireUser, async (context) => {
    const base = {
      provider: deps.model.provider,
      model: deps.model.defaultModel,
      metered: deps.metered,
      billingUrl: deps.billingUrl,
    };
    if (context.var.actor.role !== "admin") return context.json(base);

    const live = await deps.store.findLiveByKey({
      kind: "model",
      provider: deps.model.provider,
      keyId: deps.keyId,
    });
    const source: ModelKeySource = live
      ? "vault"
      : deps.environment[environmentVariable]?.trim()
        ? "environment"
        : "none";
    return context.json({
      ...base,
      keyId: deps.keyId,
      source,
      credentialId: live?.id ?? null,
    });
  });

  return routes;
}
