import {
  type InfiniteData,
  mutationOptions,
  type QueryClient,
} from "@tanstack/react-query";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import type { AvatarColor, AvatarExpression } from "../../../../shared/avatar";
import { client } from "@/lib/client";
import {
  type AgentProfile,
  type AgentVisibility,
  agentApiPath,
  agentKeys,
} from "./queries";

export type AgentInput = {
  name: string;
  title: string;
  roleDescription: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Empty means the Bot in the box. */
  endpoint?: string;
  /** Write-only auth value; omitted when the user leaves the key field empty. */
  auth?: { header: string; value: string };
};

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Coworker operation failed";

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateAgents(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: agentKeys.all });
}

export function createAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: AgentInput): Promise<AgentProfile> =>
      client("/api/agents", "agent", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/** What a one-click create answers with: the Bot, and the conversation it is about to speak in. */
export type QuickCreatedAgent = { agent: AgentProfile; channel: AgentChannel };

/**
 * "Create new Bot" in one click: the server makes New Bot and its conversation with this person,
 * answers at once, and starts the Bot's first turn on its own. See `server/src/agents/first-turn.ts`.
 *
 * THE CONVERSATION IS PUT INTO THE ROSTER BY HAND rather than by refetching it. The server announces
 * the Bot's turn as a transient busy flag on the roster row, and a refetch drops that flag; patching
 * the row in keeps the sidebar's working dot for a turn that may already have started. A roster
 * that is not loaded yet has nothing to patch and will fetch the row with everything else.
 */
export function quickCreateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<QuickCreatedAgent> => {
      const response = await client("/api/agents", {
        method: "POST",
        body: { quick: true },
        fallback: "The new Bot could not be created.",
      });
      return (await response.json()) as QuickCreatedAgent;
    },
    onSuccess: ({ channel }) => {
      queryClient.setQueryData(channelKeys.detail(channel.id), channel);
      queryClient.setQueryData<InfiniteData<ChannelPage>>(
        channelKeys.list(),
        (data) => {
          const [first, ...rest] = data?.pages ?? [];
          if (!data || !first) return data;
          if (first.channels.some((row) => row.id === channel.id)) return data;
          const row: ChannelSummary = {
            ...channel,
            summary: null,
            lastMessage: null,
            lastMessageAgentId: null,
            createdAt: new Date().toISOString(),
            pinned: false,
            lastReadAt: null,
          };
          return {
            ...data,
            pages: [{ ...first, channels: [row, ...first.channels] }, ...rest],
          };
        },
      );
      return invalidateAgents(queryClient);
    },
  });
}

export function updateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      input: AgentInput;
    }): Promise<AgentProfile> =>
      client(agentApiPath(variables.agentId), "agent", {
        method: "PATCH",
        body: variables.input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * A change to a Bot's avatar: whichever half was picked, or null to hand it back to the seed.
 *
 * Only the half that changed is sent. The server reads a body with nothing but these keys as an
 * avatar choice, so a click on a swatch does not have to carry the whole profile with it.
 */
export type AvatarChoiceInput = {
  avatarColor?: AvatarColor | null;
  avatarExpression?: AvatarExpression | null;
};

export function setAgentAvatarMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    /*
     * One at a time. Each click is its own write, and two clicks in quick succession sent side by
     * side could land in either order, leaving the server on the first while the screen shows the
     * second. A shared scope queues them in the order they were made.
     */
    scope: { id: "agent-avatar" },
    mutationFn: (variables: {
      agentId: string;
      choice: AvatarChoiceInput;
    }): Promise<AgentProfile> =>
      client(agentApiPath(variables.agentId), "agent", {
        method: "PATCH",
        body: variables.choice,
        fallback: FALLBACK,
      }),
    // The whole entity, because a face is drawn from the roster, the detail and the cache the
    // sidebar subscribes to alike, and every one of them has to show the new choice.
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function duplicateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<AgentProfile> =>
      client(`${agentApiPath(agentId)}/duplicate`, "agent", {
        method: "POST",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentHiddenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; hidden: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.hidden ? "hide" : "unhide"}`,
        { method: "POST", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentPinnedMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; pinned: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.pinned ? "pin" : "unpin"}`,
        { method: "POST", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function deleteAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(agentApiPath(agentId), {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Issue this coworker a credential for calling tools back, and hand it over once.
 *
 * The token is in this response and nowhere else, ever again, so the caller has to show it to the
 * person immediately. Calling this on a coworker that already has one rotates it, which is how a
 * leaked token is retired.
 */
export function issueCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<string> =>
      client(`${agentApiPath(agentId)}/callback-token`, "token", {
        method: "POST",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/** Take the credential away. The coworker may still talk; it may not reach anything outside a chat. */
export function revokeCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(`${agentApiPath(agentId)}/callback-token`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Whether one Bot may hand work to another.
 *
 * The same `plugin_grants` write every other grant makes, with `kind: "bot"`, so the audit row and
 * the refusals are the ones already in place: an administrator only, never a Bot on itself, and
 * never onto a Bot that does not exist.
 *
 * DIRECTIONAL, and the two ids are easy to swap: `agentId` is the Bot doing the asking and `ref` is
 * the Bot it may reach. Granted the other way round it reads as working and hands over nothing.
 */
export function setHandoffGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      /** The Bot doing the asking. */
      agentId: string;
      /** The Bot it may reach. */
      ref: string;
      granted: boolean;
    }) => {
      if (variables.granted) {
        await client("/api/plugins/grants", {
          method: "POST",
          body: { kind: "bot", ref: variables.ref, agentId: variables.agentId },
          fallback: FALLBACK,
        });
        return;
      }
      await client(
        `/api/plugins/grants?kind=bot&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}
