import { expect, test } from "bun:test";
import { botPanelSearchSchema } from "../src/lib/bot-panel";
import {
  startedChannelTarget,
  startWithChosen,
} from "../src/lib/channels/start";

/**
 * A conversation whose coworker the person picked themselves has to reach the trail the same way a
 * routed one does. `/channel/new` — the sidebar's +, a coworker's card, its profile — started the
 * channel and told nobody; the home composer told the server about an `@`. Both now run this one
 * sequence, so what it does is what the trail sees.
 */

function harness(record: (text: string, agentId: string) => Promise<unknown>) {
  const calls: string[] = [];
  return {
    calls,
    record: (text: string, agentId: string) => {
      calls.push(`record ${agentId} ${text}`);
      return record(text, agentId);
    },
    start: async (agentId: string, text: string) => {
      calls.push(`start ${agentId} ${text}`);
    },
  };
}

test("tells the server the choice before the channel is made", async () => {
  const { calls, record, start } = harness(async () => ({
    agentId: "risk-analyst",
  }));

  await startWithChosen({
    agentId: "risk-analyst",
    text: "hello",
    record,
    start,
  });

  expect(calls).toEqual([
    "record risk-analyst hello",
    "start risk-analyst hello",
  ]);
});

test("a record that fails to write does not stop the conversation", async () => {
  const { calls, record, start } = harness(async () => {
    throw new Error("Could not choose a coworker.");
  });

  await startWithChosen({
    agentId: "risk-analyst",
    text: "hello",
    record,
    start,
  });

  expect(calls).toEqual([
    "record risk-analyst hello",
    "start risk-analyst hello",
  ]);
});

test("the server's answer cannot change who the person chose", async () => {
  const { calls, record, start } = harness(async () => ({
    agentId: "somebody-else",
  }));

  await startWithChosen({
    agentId: "risk-analyst",
    text: "hello",
    record,
    start,
  });

  expect(calls[1]).toBe("start risk-analyst hello");
});

test("a channel that cannot be started still fails the send", async () => {
  const { record } = harness(async () => undefined);
  const start = async () => {
    throw new Error("Could not start a channel");
  };

  await expect(
    startWithChosen({ agentId: "risk-analyst", text: "hello", record, start }),
  ).rejects.toThrow("Could not start a channel");
});

/**
 * Where a just-created channel opens. Every caller but one opens it plainly; `/channel/new` asks for
 * the Computer tab on somebody's very first send, because that tab's screenshot poll is what starts
 * the Bot's browser, and the channel route has to take what it was asked for.
 */
test("a new channel opens plainly unless the caller names a panel", () => {
  expect(startedChannelTarget("channel_1")).toEqual({
    params: { channelId: "channel_1" },
    replace: true,
    to: "/channel/$channelId",
  });
});

test("a new channel asked to open on the Computer tab says so in its search", () => {
  const target = startedChannelTarget("channel_1", { panel: "computer" });
  expect(target).toEqual({
    params: { channelId: "channel_1" },
    replace: true,
    search: { panel: "computer" },
    to: "/channel/$channelId",
  });
  // The channel route's own search validation keeps it.
  expect(botPanelSearchSchema.parse(target.search)).toEqual({
    panel: "computer",
  });
});
