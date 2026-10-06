import { describe, expect, test } from "bun:test";
import {
  ASSISTANT_AGENT_ID,
  defaultAgentId,
  defaultAgentProfile,
  PICKED_HARNESS_AGENT_ID,
} from "@/lib/agents/default-agent";
import type { AgentProfile } from "@/lib/agents/queries";

function agent(id: string, name = id): AgentProfile {
  return {
    avatarSeed: id,
    builtIn: id === "general-assistant",
    canManage: true,
    endpoint: id === PICKED_HARNESS_AGENT_ID ? "http://127.0.0.1:4201" : null,
    hasAuth: false,
    hasCallbackToken: false,
    hidden: false,
    pinned: false,
    id,
    mine: true,
    name,
    roleDescription: "Role",
    systemOwned: false,
    title: name,
    visibility: "private",
  };
}

describe("default agent selection", () => {
  test("prefers the picked harness over the first visible agent", () => {
    const chosen = defaultAgentProfile([
      agent("general-assistant", "General Assistant"),
      agent(PICKED_HARNESS_AGENT_ID, "LangGraph"),
    ]);

    expect(chosen?.id).toBe(PICKED_HARNESS_AGENT_ID);
    expect(
      defaultAgentId([
        agent("general-assistant"),
        agent(PICKED_HARNESS_AGENT_ID),
      ]),
    ).toBe(PICKED_HARNESS_AGENT_ID);
  });

  /*
   * The tenant's built-in Noë sits between the package pick and everything else: a fresh Noë Bot
   * workspace has no picked harness, and its home must land on Noë rather than on whichever
   * coworker happens to be first in the roster or on the route's own fallback.
   */
  test("prefers the built-in assistant when there is no picked harness", () => {
    const general = agent("general-assistant", "General Assistant");
    const noe = agent(ASSISTANT_AGENT_ID, "Noë");
    const shared = agent("shared-agent", "Shared Agent");

    expect(defaultAgentProfile([general, noe], shared)?.id).toBe(
      ASSISTANT_AGENT_ID,
    );
    expect(defaultAgentId([general, noe])).toBe(ASSISTANT_AGENT_ID);
    // The package pick still outranks it.
    expect(
      defaultAgentId([noe, agent(PICKED_HARNESS_AGENT_ID, "LangGraph")]),
    ).toBe(PICKED_HARNESS_AGENT_ID);
  });

  test("keeps the route-specific fallback when there is no picked harness or assistant", () => {
    const general = agent("general-assistant", "General Assistant");
    const shared = agent("shared-agent", "Shared Agent");

    expect(defaultAgentProfile([general, shared], shared)?.id).toBe(
      "shared-agent",
    );
  });

  test("falls back to the first agent when no picked harness or route fallback exists", () => {
    expect(
      defaultAgentId([agent("general-assistant"), agent("researcher")]),
    ).toBe("general-assistant");
  });

  test("returns undefined when the roster is still absent", () => {
    expect(defaultAgentId(undefined)).toBeUndefined();
  });
});
