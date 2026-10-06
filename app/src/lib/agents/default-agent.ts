import type { AgentProfile } from "./queries";

export const PICKED_HARNESS_AGENT_ID = "picked-harness";

/**
 * The tenant's built-in Noë (`examples/noebot/agents.yaml`): the coworker a fresh workspace talks
 * to first, and the one home lands on when there is no conversation to return to yet.
 */
export const ASSISTANT_AGENT_ID = "assistant";

/**
 * Which coworker stands in when nobody chose one.
 *
 * In order: the package-picked harness, then the built-in Noë, then whatever the caller would
 * rather fall back to, then the first of the roster. `server/src/routing/routes.ts`
 * (`defaultRoutingProfile`) mirrors this order; the two must agree, or a message sent with no
 * `@` lands with a different coworker than the one the composer said it would.
 */
export function defaultAgentProfile(
  agents: readonly AgentProfile[] | undefined,
  fallback?: AgentProfile,
): AgentProfile | undefined {
  return (
    agents?.find((candidate) => candidate.id === PICKED_HARNESS_AGENT_ID) ??
    agents?.find((candidate) => candidate.id === ASSISTANT_AGENT_ID) ??
    fallback ??
    agents?.[0]
  );
}

export function defaultAgentId(
  agents: readonly AgentProfile[] | undefined,
): string | undefined {
  return defaultAgentProfile(agents)?.id;
}
