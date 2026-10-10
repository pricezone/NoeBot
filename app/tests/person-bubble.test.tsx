import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import {
  GROUP_PERSON_SCHEME,
  personBubbleScheme,
} from "@/components/channels/bubbles";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { GroupChat } from "@/components/channels/group-chat";
import { schemeFor } from "@/components/noe-bot/pixel-art";
import { authKeys } from "@/lib/auth/queries";
import { type GroupConversation, groupKeys } from "@/lib/groups";

/**
 * Whose colour the person's words are in.
 *
 * A conversation with one Bot draws them in that Bot's avatar colour — the chosen one, or the
 * seed's — so the bubbles and the avatar always agree. A group has no one Bot to borrow from and
 * uses the near-black. The Bot's own words are grey in both.
 */

const realFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Nothing here should reach a server; anything that tries is answered with an empty success.
  globalThis.fetch = (async () =>
    new Response("{}", {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
});
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

const conversation: Message[] = [
  { id: "m1", role: "user", content: "Restore the coupon email." },
  { id: "m2", role: "assistant", content: "Done." },
];

function bubbleOf(view: ReturnType<typeof render>, text: string) {
  const bubble = view
    .getByText(text)
    .closest<HTMLElement>('[data-slot="bubble"]');
  return {
    variant: bubble?.getAttribute("data-variant"),
    color: bubble?.style.getPropertyValue("--bubble"),
    ink: bubble?.style.getPropertyValue("--bubble-foreground"),
    border:
      bubble?.querySelector('[data-slot="bubble-content"]')?.className ?? "",
  };
}

test("one Bot lends its chosen colour; with none chosen, the colour its avatar has from its seed", () => {
  expect(
    personBubbleScheme([{ seed: "sendy", color: "#7c3aed" }]).background,
  ).toBe("#7c3aed");
  expect(personBubbleScheme([{ seed: "sendy", color: null }])).toBe(
    schemeFor("sendy"),
  );
});

test("a group, or no Bot at all, is the near-black with white ink", () => {
  const group = personBubbleScheme([
    { seed: "sendy", color: "#7c3aed" },
    { seed: "noe", color: "#2563eb" },
  ]);
  expect(group).toBe(GROUP_PERSON_SCHEME);
  expect(personBubbleScheme([])).toBe(GROUP_PERSON_SCHEME);
  expect(GROUP_PERSON_SCHEME.background).toBe("#18181b");
  expect(GROUP_PERSON_SCHEME.ink).toBe("#ffffff");
});

test("in a conversation with one Bot the person's bubble is that Bot's colour and the Bot's is grey", () => {
  const scheme = personBubbleScheme([{ seed: "sendy", color: "#7c3aed" }]);
  const view = render(
    <ChatTranscript messages={conversation} personScheme={scheme} />,
  );

  const mine = bubbleOf(view, "Restore the coupon email.");
  expect(mine.variant).toBe("custom");
  expect(mine.color).toBe("#7c3aed");
  expect(mine.ink).toBe("#ffffff");

  expect(bubbleOf(view, "Done.").variant).toBe("muted");
});

test("the colours that vanish into a page get a hairline there, and only those", () => {
  const grey = render(
    <ChatTranscript
      messages={conversation}
      personScheme={personBubbleScheme([{ seed: "x", color: "#f4f4f5" }])}
    />,
  );
  expect(bubbleOf(grey, "Restore the coupon email.").border).toContain(
    "border-black/10",
  );
  cleanup();

  // Left out, the transcript draws the group colour, which needs its edge in the dark theme.
  const group = render(<ChatTranscript messages={conversation} />);
  const mine = bubbleOf(group, "Restore the coupon email.");
  expect(mine.color).toBe("#18181b");
  expect(mine.border).toContain("dark:border-white/15");
  cleanup();

  const violet = render(
    <ChatTranscript
      messages={conversation}
      personScheme={personBubbleScheme([{ seed: "x", color: "#7c3aed" }])}
    />,
  );
  const border = bubbleOf(violet, "Restore the coupon email.").border;
  expect(border).not.toContain("border-black/10");
  expect(border).not.toContain("border-white/15");
});

test("in a group chat my words are near-black, a teammate's and the Bots' are grey", () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const group: GroupConversation = {
    bots: [{ id: "bot-1", name: "Sendy" }],
    people: [],
    messages: [
      {
        id: "g1",
        channelId: "group-1",
        ownerUserId: "me",
        agentId: null,
        text: "Which list is bigger?",
        status: "completed",
        createdAt: "2026-10-10T10:00:00.000Z",
      },
      {
        id: "g2",
        channelId: "group-1",
        ownerUserId: "teammate",
        agentId: null,
        text: "And by how much?",
        status: "completed",
        createdAt: "2026-10-10T10:00:01.000Z",
      },
      {
        id: "g3",
        channelId: "group-1",
        ownerUserId: "me",
        agentId: "bot-1",
        text: "The English one.",
        status: "completed",
        createdAt: "2026-10-10T10:00:02.000Z",
      },
    ],
  };
  client.setQueryData(groupKeys.detail("group-1"), group);
  client.setQueryData(authKeys.currentUser(), {
    id: "me",
    email: "me@example.test",
    name: "Me",
    role: "user",
  } as never);

  const view = render(
    <QueryClientProvider client={client}>
      <GroupChat channelId="group-1" />
    </QueryClientProvider>,
  );

  const mine = bubbleOf(view, "Which list is bigger?");
  expect(mine.variant).toBe("custom");
  expect(mine.color).toBe("#18181b");
  expect(mine.ink).toBe("#ffffff");
  expect(bubbleOf(view, "And by how much?").variant).toBe("muted");
  expect(bubbleOf(view, "The English one.").variant).toBe("muted");
});
