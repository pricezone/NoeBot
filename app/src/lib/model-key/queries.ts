import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The model the Bots run on, as the Keys page says it: `GET /api/settings/model-key`.
 *
 * Everybody gets the provider and the model; an administrator also learns where the key in force
 * comes from — the credential vault (replaceable here), the deployment's environment, or nowhere
 * — and the vault row's id, so "use the deployment's key again" knows what to revoke. The secret
 * itself is never on the wire.
 */
export type ModelKeyPage = {
  provider: "openai" | "anthropic";
  model: string;
  /** Metered by the platform: the model is reached through its gateway, so no personal key applies. */
  metered: boolean;
  billingUrl: string | null;
  keyId?: string;
  source?: "vault" | "environment" | "none";
  credentialId?: string | null;
};

export const modelKeyKeys = {
  all: ["model-key"] as const,
};

export function modelKeyQueryOptions() {
  return queryOptions({
    queryKey: modelKeyKeys.all,
    queryFn: async (): Promise<ModelKeyPage> => {
      const response = await client("/api/settings/model-key", {
        fallback: "The model key could not be loaded.",
      });
      return response.json();
    },
  });
}
