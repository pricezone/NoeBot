import {
  type InfiniteData,
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import { patchRosterRow } from "./mutations";
import { type ChannelPage, channelKeys } from "./queries";

/**
 * A heading in this person's sidebar, which conversations are filed under.
 *
 * One person's own, like a pin: nobody else in a conversation sees how its members file it. Which
 * section a conversation is under rides on its roster row (`ChannelSummary.sectionId`), so moving
 * one is a patch to the roster and not to this list.
 */
export type SidebarSection = {
  id: string;
  name: string;
  /** Drawn smallest first. */
  position: number;
};

/** The longest name the server takes, in code points. Mirrors `MAX_SECTION_NAME_CODE_POINTS`. */
export const MAX_SECTION_NAME_LENGTH = 60;

export const sectionKeys = {
  all: ["sidebar-sections"] as const,
};

const SECTIONS_PATH = "/api/channels/sections";

export function sectionListQueryOptions() {
  return queryOptions({
    queryKey: sectionKeys.all,
    queryFn: (): Promise<SidebarSection[]> =>
      client(SECTIONS_PATH, "sections", {
        fallback: "Could not load your sections",
      }),
  });
}

/** Keep the cached list in the order the sidebar draws it, whatever order the writes landed in. */
function inOrder(sections: SidebarSection[]): SidebarSection[] {
  return [...sections].sort((a, b) => a.position - b.position);
}

/** A new section, after every other one. Appended to the cache rather than refetched. */
export function createSectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (name: string): Promise<SidebarSection> =>
      client(SECTIONS_PATH, "section", {
        method: "POST",
        body: { name },
        fallback: "Could not create this section",
      }),
    onSuccess: (section) =>
      queryClient.setQueryData(
        sectionKeys.all,
        (sections: SidebarSection[] | undefined) =>
          inOrder([...(sections ?? []), section]),
      ),
  });
}

export function renameSectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      sectionId: string;
      name: string;
    }): Promise<SidebarSection> =>
      client(`${SECTIONS_PATH}/${variables.sectionId}`, "section", {
        method: "PATCH",
        body: { name: variables.name },
        fallback: "Could not rename this section",
      }),
    onSuccess: (section) =>
      queryClient.setQueryData(
        sectionKeys.all,
        (sections: SidebarSection[] | undefined) =>
          sections?.map((existing) =>
            existing.id === section.id ? section : existing,
          ),
      ),
  });
}

/**
 * Delete a section. Its conversations are not deleted: the server drops their placements with it,
 * and the same is done to the cached rows here, so they fall back into the ungrouped list at once
 * instead of after a refetch of the whole roster.
 */
export function deleteSectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (sectionId: string) => {
      await client(`${SECTIONS_PATH}/${sectionId}`, {
        method: "DELETE",
        fallback: "Could not delete this section",
      });
    },
    onSuccess: (_result, sectionId) => {
      queryClient.setQueryData(
        sectionKeys.all,
        (sections: SidebarSection[] | undefined) =>
          sections?.filter((section) => section.id !== sectionId),
      );
      queryClient.setQueryData(
        channelKeys.list(),
        (data: InfiniteData<ChannelPage> | undefined) =>
          data && {
            ...data,
            pages: data.pages.map((page) =>
              page.channels.some((row) => row.sectionId === sectionId)
                ? {
                    ...page,
                    channels: page.channels.map((row) =>
                      row.sectionId === sectionId
                        ? { ...row, sectionId: null }
                        : row,
                    ),
                  }
                : page,
            ),
          },
      );
    },
  });
}

/**
 * Draw the sections in this order: every one of this person's sections, each once. The server
 * refuses an order made from a list that has since changed, and the refusal is shown; the cache is
 * then refetched so the next attempt starts from the truth.
 */
export function reorderSectionsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (sectionIds: string[]): Promise<SidebarSection[]> =>
      client(`${SECTIONS_PATH}/order`, "sections", {
        method: "PUT",
        body: { sectionIds },
        fallback: "Could not reorder your sections",
      }),
    onSuccess: (sections) =>
      queryClient.setQueryData(sectionKeys.all, inOrder(sections)),
    onError: () => queryClient.invalidateQueries({ queryKey: sectionKeys.all }),
  });
}

/**
 * File a conversation under a section, or take it out of one with null.
 *
 * Patched before the wire answers, so the row moves the moment the menu closes. A failure refetches
 * the roster, which puts it back under whatever the server still has.
 */
export function setChannelSectionMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      channelId: string;
      sectionId: string | null;
    }) => {
      await client(`/api/channels/${variables.channelId}/section`, {
        method: "PUT",
        body: { sectionId: variables.sectionId },
        fallback: "Could not move this chat",
      });
    },
    onMutate: ({ channelId, sectionId }) =>
      patchRosterRow(queryClient, channelId, () => ({ sectionId })),
    onError: () =>
      queryClient.invalidateQueries({ queryKey: channelKeys.list() }),
  });
}
