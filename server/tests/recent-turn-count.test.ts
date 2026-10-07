import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  guardBotTurn,
  recentTurnCount,
  resetBotLifecycleForTests,
} from "../src/agents/lifecycle";

// Module state: other files register turns too, so it starts and ends empty here.
beforeEach(() => resetBotLifecycleForTests());
afterEach(() => resetBotLifecycleForTests());

test("counts background turns started recently, and stops counting them once they are old", async () => {
  expect(recentTurnCount(60_000)).toBe(0);
  await guardBotTurn({ ownerUserId: "user-1", agentId: "bot-1" });
  await guardBotTurn({ ownerUserId: "user-1", agentId: "bot-2" });

  expect(recentTurnCount(60_000)).toBe(2);
  expect(recentTurnCount(60_000, Date.now() + 120_000)).toBe(0);
});
