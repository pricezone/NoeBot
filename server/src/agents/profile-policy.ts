import type { AgentActor, AgentProfile } from "./profile-types";

export function canAccessAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.deletedAt !== null) return false;

  return (
    agent.visibility === "public" ||
    agent.ownerUserId === actor.id ||
    actor.role === "admin"
  );
}

export function canManageAgent(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (agent.systemOwned || agent.deletedAt !== null) return false;

  return agent.ownerUserId === actor.id || actor.role === "admin";
}

/**
 * Whether this person may change how this Bot looks: its avatar's colour and expression.
 *
 * Everybody who may manage the Bot, and ALSO an administrator on a Bot the tenant package ships,
 * which nobody may manage. The package's protection exists so a deployment's own Bots keep the
 * name, role and instructions the package gave them; the avatar choice is none of those — the
 * package never writes it, so a sync cannot fight over it — and without this the Bot a deployment
 * is built around would be the one Bot whose face nobody could change. Administrators only,
 * because a package Bot is public: one member's choice would be everybody's.
 */
export function canEditAgentAvatar(
  actor: AgentActor,
  agent: AgentProfile,
): boolean {
  if (canManageAgent(actor, agent)) return true;
  return (
    agent.systemOwned && agent.deletedAt === null && actor.role === "admin"
  );
}

export const canRunAgent = canAccessAgent;

/**
 * Whether this person may act as this Bot.
 *
 * Injected rather than imported, so a surface that acts as a Bot depends on the question and not on
 * the agents table. It also keeps the answer in one place: the store's read path already filters on
 * {@link canAccessAgent}, so asking it is the same rule the roster and the runtime already apply,
 * rather than a second copy that can drift from them.
 */
export type BotAccessCheck = (
  /** The whole actor, not just the id: an administrator reaches every Bot, and a role tells us. */
  actor: AgentActor,
  botId: string,
) => Promise<boolean>;
