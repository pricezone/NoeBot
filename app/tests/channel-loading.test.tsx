import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelLoading } from "@/components/channels/channel-loading";
import {
  type AgentChannel,
  CHANNEL_RECONNECT_DELAYS_MS,
  channelKeys,
  channelQueryOptions,
} from "@/lib/channels/queries";
import type { UiLanguage } from "@/lib/i18n/strings";
import { settleReactWork } from "./settle-react-work";

/**
 * The channel screen through a server restart.
 *
 * FOUND LIVE: the server restarted for an automatic update mid-conversation, the channel read failed,
 * and the screen said "Could not load this channel." until a reload. Now an unreachable server (no
 * answer, or a 502/503/504 from the gateway in front of it) is asked again for about two minutes
 * while the screen says it is reconnecting; a refusal is said at once.
 */

const NativeResponse = globalThis.Response;
const CHANNEL: AgentChannel = {
  id: "loading-channel",
  name: "Υπεύθυνη δήλωση",
  agentIds: ["loading-bot"],
  threadId: "loading-thread",
  active: true,
  lastMessageAt: null,
};

type Answer = () => Response | Promise<Response>;
const ok: Answer = () => NativeResponse.json({ channel: CHANNEL });
const restarting: Answer = () =>
  new NativeResponse("Bad gateway", { status: 503 });
let answers: Answer[] = [];
let otherwise: Answer = ok;
let requests = 0;
let originalFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests += 1;
    return (answers.shift() ?? otherwise)();
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  answers = [];
  otherwise = ok;
  requests = 0;
});
afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function Screen({ language }: { language: UiLanguage }) {
  // The backoff is shortened here; which failures are retried, and how often, is the route's own.
  const query = useQuery({
    ...channelQueryOptions(CHANNEL.id),
    retryDelay: 10,
  });
  return (
    <ChannelLoading language={language} query={query}>
      {(channel) => <p>Open: {channel.name}</p>}
    </ChannelLoading>
  );
}

function mount(language: UiLanguage = "en", client = new QueryClient()) {
  return {
    client,
    view: render(
      <QueryClientProvider client={client}>
        <Screen language={language} />
      </QueryClientProvider>,
    ),
  };
}

function deferred() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { answer: () => promise, resolve };
}

test("a 503 while the server restarts reads as reconnecting, and the conversation opens once it answers", async () => {
  const comingBack = deferred();
  answers = [restarting, comingBack.answer];
  const { view } = mount();

  expect(await view.findByText("Reconnecting…")).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();

  await act(async () => comingBack.resolve(await ok()));
  expect(await view.findByText(`Open: ${CHANNEL.name}`)).toBeTruthy();
  expect(requests).toBe(2);
});

test("no answer at all is the same: reconnecting, in the conversation's language", async () => {
  const comingBack = deferred();
  answers = [
    () => {
      throw new TypeError("Failed to fetch");
    },
    comingBack.answer,
  ];
  const { view } = mount("el");

  expect(await view.findByText("Επανασύνδεση…")).toBeTruthy();
  await act(async () => comingBack.resolve(await ok()));
  expect(await view.findByText(`Open: ${CHANNEL.name}`)).toBeTruthy();
});

test("a 404 is said at once, in the server's words, and not asked again", async () => {
  answers = [
    () => NativeResponse.json({ error: "Channel not found." }, { status: 404 }),
  ];
  const { view } = mount("el");

  expect(await view.findByText("Η συνομιλία δεν βρέθηκε.")).toBeTruthy();
  expect(view.queryByText("Επανασύνδεση…")).toBeNull();
  expect(view.queryByRole("button")).toBeNull();
  await settleReactWork();
  expect(requests).toBe(1);
});

test("a server that stays away past the window gets the error and a Retry that recovers", async () => {
  otherwise = restarting;
  const { view } = mount();

  const alert = await view.findByRole("alert", {}, { timeout: 3000 });
  expect(alert.textContent).toContain("Could not load this channel.");
  // The first read and every retry in the window.
  expect(requests).toBe(CHANNEL_RECONNECT_DELAYS_MS.length + 1);

  otherwise = ok;
  const user = userEvent.setup({ document });
  await user.click(view.getByRole("button", { name: "Retry" }));
  expect(await view.findByText(`Open: ${CHANNEL.name}`)).toBeTruthy();
});

test("a conversation already on screen stays there while a later read cannot reach the server", async () => {
  const { client, view } = mount();
  expect(await view.findByText(`Open: ${CHANNEL.name}`)).toBeTruthy();

  otherwise = restarting;
  await act(async () => {
    await client
      .refetchQueries({ queryKey: channelKeys.detail(CHANNEL.id) })
      .catch(() => undefined);
  });
  await waitFor(() =>
    expect(requests).toBe(CHANNEL_RECONNECT_DELAYS_MS.length + 2),
  );
  await settleReactWork();
  expect(view.getByText(`Open: ${CHANNEL.name}`)).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
});
