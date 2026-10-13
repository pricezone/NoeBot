import type { Tool } from "@ag-ui/client";
import {
  formatSkillCatalog,
  loadSkill,
  readSkillFile,
  SkillRegistry,
} from "@copilotkit/runtime/internal/learned-skills";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type {
  LearningDeliveryStatus,
  LearningSettings,
  LearningTarget,
} from "../../../shared/learning";
import type { LearningSettingsStore } from "./settings";

// This published internal export is pinned to runtime 1.73.1. Keep its use here: the SDK owns
// archive verification, refresh, revocation and stale-cache policy for every OpenBot framework.
export type LearnedSkillInvocation = {
  readonly catalog: string;
  readonly tools: readonly Tool[];
  execute(name: string, args: unknown): Promise<string>;
};
export type AcquireLearnedSkills = (
  agentId: string,
  signal?: AbortSignal,
) => Promise<LearnedSkillInvocation | undefined>;

export const LEARNED_SKILL_TOOL_NAMES = new Set([
  "copilotkit_load_skill",
  "copilotkit_read_skill_file",
]);
const skillArgs = z.object({ skill_name: z.string().min(1) }).strict();
const fileArgs = skillArgs.extend({ path: z.string().min(1) }).strict();
const skillTools: readonly Tool[] = [
  {
    name: "copilotkit_load_skill",
    description:
      "Load a published learned Skill's instructions and supporting file names.",
    parameters: z.toJSONSchema(skillArgs),
  },
  {
    name: "copilotkit_read_skill_file",
    description:
      "Read one supporting text file from a published learned Skill.",
    parameters: z.toJSONSchema(fileArgs),
  },
];

export function selectLearningTarget(
  settings: LearningSettings,
  agentId: string,
): LearningTarget | undefined {
  if (!settings.enabled) return undefined;
  return (
    (Object.hasOwn(settings.agents, agentId)
      ? settings.agents[agentId]
      : settings.defaultTarget) ?? undefined
  );
}

/** Cancel this invocation's wait without cancelling another invocation's shared refresh. */
function waitForSnapshot<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Called once after loadConfig consumes the environment default, before any registry exists. */
export function clearLearningRevisionFallback(
  environment: Record<string, string | undefined> = process.env,
): void {
  delete environment.CPK_INTELLIGENCE_SKILLS_REVISION;
}

export type LearningThread = {
  threadId: string;
  agentId: string;
  userId: string;
};

/**
 * How long a conversation's Learning container is remembered in this process.
 *
 * The binding is insert-once, so once a conversation is bound its answer never changes; the time
 * limit only bounds memory and a binding another replica made while this one held "unbound".
 */
const CONTAINER_TTL_MS = 10 * 60_000;
const MAX_REMEMBERED_CONTAINERS = 10_000;

export function createLearningRuntime(options: {
  store: LearningSettingsStore;
  client: CopilotKitIntelligence;
  freshnessWindowMs?: number;
  containerTtlMs?: number;
}) {
  const { store, client } = options;
  const containerTtlMs = options.containerTtlMs ?? CONTAINER_TTL_MS;
  /*
   * Every run asked the platform whether its Thread exists (getThread) and wrote the binding again,
   * before the run could start. A conversation's answer is settled the first time it is bound, so it
   * is kept here, per person and conversation; concurrent asks share one lookup.
   */
  const containers = new Map<
    string,
    { containerId: string | null; at: number }
  >();
  const resolving = new Map<string, Promise<string | undefined>>();
  const resolveContainer = async (
    input: LearningThread,
    target: LearningTarget,
  ): Promise<string | undefined> => {
    /*
     * Whether the Thread already exists, asked of the platform. A 404 is the expected answer for
     * a new conversation. Anything else is the platform's trouble, not this conversation's: tried
     * once more a moment later, and then answered "no container this turn" rather than thrown.
     *
     * Thrown, this is what the runtime turned into "Failed to resolve Learning Container" and a
     * failed turn, before the run had even asked for the Thread: a 502 from the platform ended
     * every turn on the deployment for the two minutes it lasted, in the name of a feature that is
     * best-effort by design. Not bound, deliberately: the binding is insert-once, so writing null
     * here would exclude the Thread from Learning for good, while leaving it unbound lets the next
     * turn bind it if the Thread was never created.
     */
    const exists = await threadExists(client, input, 1);
    if (exists === undefined) return undefined;
    const containerId = await store.bindThread({
      userId: input.userId,
      threadId: input.threadId,
      agentId: input.agentId,
      containerId: exists ? null : (target?.containerId ?? null),
    });
    // Only a settled answer is remembered; "could not say" is asked again next turn.
    if (containers.size >= MAX_REMEMBERED_CONTAINERS) {
      const cutoff = Date.now() - containerTtlMs;
      for (const [key, entry] of containers)
        if (entry.at < cutoff) containers.delete(key);
      // Still full of live entries: start again rather than grow without bound.
      if (containers.size >= MAX_REMEMBERED_CONTAINERS) containers.clear();
    }
    containers.set(JSON.stringify([input.userId, input.threadId]), {
      containerId,
      at: Date.now(),
    });
    return containerId ?? undefined;
  };
  const registries = new Map<string, SkillRegistry>();
  const registryKey = (target: LearningTarget) =>
    JSON.stringify([target.containerId, target.revision]);
  const registryFor = (target: LearningTarget) => {
    const key = registryKey(target);
    let registry = registries.get(key);
    if (!registry) {
      registry = new SkillRegistry({
        client,
        containerId: target.containerId,
        ...(target.revision ? { revision: target.revision } : {}),
        ...(options.freshnessWindowMs === undefined
          ? {}
          : { freshnessWindowMs: options.freshnessWindowMs }),
      });
      registries.set(key, registry);
    }
    return registry;
  };

  const acquire: AcquireLearnedSkills = async (agentId, signal) => {
    signal?.throwIfAborted();
    const target = selectLearningTarget(await store.read(), agentId);
    signal?.throwIfAborted();
    if (!target) return undefined;
    const snapshot = await waitForSnapshot(
      registryFor(target).acquireSnapshot(),
      signal,
    );
    signal?.throwIfAborted();
    return {
      catalog: snapshot.skills.length > 0 ? formatSkillCatalog(snapshot) : "",
      tools: snapshot.skills.length > 0 ? skillTools : [],
      execute: async (name, args) => {
        if (name === "copilotkit_load_skill") {
          return loadSkill(snapshot, skillArgs.parse(args).skill_name);
        }
        if (name === "copilotkit_read_skill_file") {
          const parsed = fileArgs.parse(args);
          return readSkillFile(snapshot, parsed.skill_name, parsed.path);
        }
        throw new Error("That is not a learned Skill tool.");
      },
    };
  };

  return {
    acquire,
    /**
     * Bind once, before thread creation. The SDK calls this selector before its ownership check,
     * so the verified user scopes the durable decision. Existing Threads are never backfilled.
     */
    async containerForThread(
      input: LearningThread,
    ): Promise<string | undefined> {
      if (!input.userId.trim())
        throw new Error("Learning Thread assignment requires a verified user.");
      // Read every time: switching Learning off reaches the next run, cached conversations included.
      const target = selectLearningTarget(await store.read(), input.agentId);
      if (!target) return undefined;
      const key = JSON.stringify([input.userId, input.threadId]);
      const known = containers.get(key);
      if (known && Date.now() - known.at < containerTtlMs)
        return known.containerId ?? undefined;
      if (known) containers.delete(key);
      const pending = resolving.get(key);
      if (pending) return pending;
      const lookup = resolveContainer(input, target).finally(() => {
        resolving.delete(key);
      });
      resolving.set(key, lookup);
      return lookup;
    },
    async status(agentId: string): Promise<LearningDeliveryStatus> {
      const target = selectLearningTarget(await store.read(), agentId);
      if (!target)
        return { configured: false, initialized: false, stale: false };
      const status = registries.get(registryKey(target))?.status;
      return {
        configured: true,
        containerId: target.containerId,
        initialized: status?.initialized ?? false,
        stale: status?.stale ?? false,
        ...(status?.revision ? { revision: status.revision } : {}),
        ...(status?.lastCheckedAt
          ? { lastCheckedAt: status.lastCheckedAt }
          : {}),
        ...(status?.lastError ? { error: status.lastError } : {}),
      };
    },
    inspect: (
      input: Parameters<CopilotKitIntelligence["getInspectorLearning"]>[0],
    ) => client.getInspectorLearning(input),
  };
}
/**
 * Whether the platform knows the Thread: true, false (a 404), or undefined when it could not say.
 *
 * `retries` more attempts follow a failure that is the platform's (a 5xx, an error it marks
 * retryable, a malformed answer, the network), 300 ms apart. A 4xx other than 404 is not retried:
 * the platform understood the question and refused it, and asking again changes nothing.
 */
async function threadExists(
  client: Pick<CopilotKitIntelligence, "getThread">,
  input: Pick<LearningThread, "threadId" | "userId" | "agentId">,
  retries: number,
): Promise<boolean | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      await client.getThread({
        threadId: input.threadId,
        userId: input.userId,
      });
      return true;
    } catch (error) {
      const platform =
        error instanceof Error && error.name === "PlatformRequestError"
          ? (error as { status?: unknown; retryable?: unknown })
          : undefined;
      if (platform?.status === 404) return false;
      const transient =
        platform === undefined ||
        platform.retryable === true ||
        (typeof platform.status === "number" && platform.status >= 500);
      if (transient && attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      console.warn({
        error: "learning_thread_lookup_failed",
        context: {
          agentId: input.agentId,
          threadId: input.threadId,
          attempts: attempt + 1,
          status: typeof platform?.status === "number" ? platform.status : null,
          name: error instanceof Error ? error.name : "unknown",
        },
        timestamp: new Date().toISOString(),
      });
      return undefined;
    }
  }
}

export type LearningRuntime = ReturnType<typeof createLearningRuntime>;
