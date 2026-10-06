import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { type ChannelSummary, channelKeys } from "@/lib/channels/queries";
import { Route as ApprovalsRoute } from "@/routes/_authed/_app/approvals";
import { Route as BotRoute } from "@/routes/_authed/_app/bots.$agentId";
import { Route as BotsRoute } from "@/routes/_authed/_app/bots.index";
import { Route as MemoryRoute } from "@/routes/_authed/_app/memory";
import { Route as ReachabilityRoute } from "@/routes/_authed/_app/reachability";
import { Route as ResponsibilitiesRoute } from "@/routes/_authed/_app/responsibilities";
import { Route as RoutinesRoute } from "@/routes/_authed/_app/routines";
import { Route as TeamBotsRoute } from "@/routes/_authed/_app/team-bots";

/**
 * The retired routes still resolve: each is a `beforeLoad` that throws a redirect to the page that
 * replaced it, carrying the search it arrived with and, for the four that became blocks of one
 * page, the hash of their block. `/bots/$agentId` is the one that decides: the Bot's newest
 * conversation with the details panel open, else a fresh conversation with that Bot.
 */

type Stub = { options: { beforeLoad?: (ctx: never) => unknown } };

/** Runs a stub's `beforeLoad` and returns the redirect it threw. */
async function redirectFrom(
  route: Stub,
  ctx: {
    search?: Record<string, unknown>;
    params?: Record<string, string>;
    queryClient?: QueryClient;
  } = {},
) {
  const beforeLoad = route.options.beforeLoad;
  if (!beforeLoad) throw new Error("The stub has no beforeLoad");
  try {
    await beforeLoad({
      search: ctx.search ?? {},
      params: ctx.params ?? {},
      context: { queryClient: ctx.queryClient ?? quietClient() },
    } as never);
  } catch (thrown) {
    if (!isRedirect(thrown)) throw thrown;
    return thrown.options as {
      to?: string;
      search?: unknown;
      hash?: string;
      params?: unknown;
      replace?: boolean;
    };
  }
  throw new Error("The stub did not redirect");
}

function quietClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const SEARCH = { new: "true", agent: "x" };

test("/bots goes to Settings › Bots with its search", async () => {
  expect(await redirectFrom(BotsRoute, { search: SEARCH })).toMatchObject({
    to: "/settings/bots",
    search: SEARCH,
    replace: true,
  });
});

test("/team-bots, /responsibilities and /routines go to their blocks", async () => {
  expect(await redirectFrom(TeamBotsRoute, { search: SEARCH })).toMatchObject({
    to: "/settings/bots",
    hash: "team",
    search: SEARCH,
  });
  expect(
    await redirectFrom(ResponsibilitiesRoute, { search: SEARCH }),
  ).toMatchObject({
    to: "/settings/bots",
    hash: "responsibilities",
    search: SEARCH,
  });
  expect(await redirectFrom(RoutinesRoute, { search: SEARCH })).toMatchObject({
    to: "/settings/bots",
    hash: "routines",
    search: SEARCH,
  });
});

test("/memory, /reachability and /approvals go to their pages", async () => {
  expect(await redirectFrom(MemoryRoute, { search: SEARCH })).toMatchObject({
    to: "/settings/memory",
    search: SEARCH,
  });
  expect(
    await redirectFrom(ReachabilityRoute, { search: SEARCH }),
  ).toMatchObject({ to: "/settings/notifications", search: SEARCH });
  expect(await redirectFrom(ApprovalsRoute, { search: SEARCH })).toMatchObject({
    to: "/settings/approvals",
    search: SEARCH,
  });
});

/** A roster row with only what the redirect reads. */
function channel(id: string, agentIds: string[]): ChannelSummary {
  return { id, agentIds } as ChannelSummary;
}

function clientWith(channels: ChannelSummary[]) {
  const client = quietClient();
  client.setQueryData(channelKeys.list(), {
    pages: [{ channels, nextCursor: null }],
    pageParams: [""],
  });
  return client;
}

test("/bots/$agentId opens the Bot's newest conversation with the details panel", async () => {
  const queryClient = clientWith([
    channel("group-1", ["noe", "other"]),
    channel("other-1", ["other"]),
    channel("noe-2", ["noe"]),
    channel("noe-1", ["noe"]),
  ]);
  expect(
    await redirectFrom(BotRoute, { params: { agentId: "noe" }, queryClient }),
  ).toMatchObject({
    to: "/channel/$channelId",
    params: { channelId: "noe-2" },
    search: { panel: "details" },
    replace: true,
  });
});

test("/bots/$agentId starts a conversation when the Bot has none", async () => {
  const queryClient = clientWith([channel("other-1", ["other"])]);
  expect(
    await redirectFrom(BotRoute, { params: { agentId: "noe" }, queryClient }),
  ).toMatchObject({
    to: "/channel/new",
    search: { agent: "noe" },
    replace: true,
  });
});

test("/bots/$agentId still redirects when the roster cannot be read", async () => {
  const queryClient = quietClient();
  // Nothing cached and no server: ensuring the roster rejects, and the stub falls back.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("offline");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    expect(
      await redirectFrom(BotRoute, {
        params: { agentId: "noe" },
        queryClient,
      }),
    ).toMatchObject({ to: "/channel/new", search: { agent: "noe" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
