import { describe, expect, test } from "bun:test";
import {
  COMPUTER_GUIDE_PERSON_DESCRIPTION,
  COMPUTER_GUIDE_PERSON_TOOL,
  POINT_AT_DESCRIPTION,
} from "../../shared/clicky-tools";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  createHeadlessComputerTools,
  HeadlessToolSuspension,
} from "../src/computer/headless-tools";

/*
 * The Bot's side of Clicky on the server: `computer_guide_person` is offered only where Clicky is on,
 * says what the browser's copy says, and installs the walkthrough; `computer_request_help` takes
 * `point_at` so Clicky can point at what the person should use first.
 */

const requests: unknown[][] = [];
const gateway = {
  requestHelp: async (...args: unknown[]) => {
    requests.push(args);
    return {
      holder: "bot",
      since: "",
      requested: true,
      request: {
        id: "r1",
        reason: "help",
        source: "model",
        status: "waiting",
        createdAt: "",
        updatedAt: "",
      },
      transitioning: false,
      resumeSnapshotRequired: false,
    };
  },
} as unknown as ComputerGateway;
const actor = { id: "user-1", userId: "user-1" };
const call = { toolCallId: "call-1", signal: new AbortController().signal };

describe("computer_guide_person", () => {
  test("is offered only where Clicky can show it", () => {
    const without = createHeadlessComputerTools({
      gateway,
      botId: "bot-1",
      actor,
    });
    expect(
      without.some(
        (tool) => tool.definition.name === COMPUTER_GUIDE_PERSON_TOOL,
      ),
    ).toBe(false);
    const withGuide = createHeadlessComputerTools({
      gateway,
      botId: "bot-1",
      actor,
      guide: async () => ({ pointed: 0, missing: [] }),
    });
    const tool = withGuide.find(
      (entry) => entry.definition.name === COMPUTER_GUIDE_PERSON_TOOL,
    );
    expect(tool?.definition.description).toBe(
      COMPUTER_GUIDE_PERSON_DESCRIPTION,
    );
  });

  test("installs the walkthrough and tells the Bot which refs were not on the screen", async () => {
    const guided: unknown[] = [];
    const tools = createHeadlessComputerTools({
      gateway,
      botId: "bot-1",
      actor,
      guide: async (input) => {
        guided.push(input);
        return { pointed: 1, missing: ["e9"] };
      },
    });
    const tool = tools.find(
      (entry) => entry.definition.name === COMPUTER_GUIDE_PERSON_TOOL,
    );
    const result = await tool?.execute(
      {
        goal: "Sign in to your bank",
        steps: [
          { say: "Type your user ID here.", ref: "e4" },
          { say: "Then press Continue.", ref: "e9" },
        ],
      },
      call,
    );
    expect(guided).toEqual([
      {
        goal: "Sign in to your bank",
        steps: [
          { say: "Type your user ID here.", ref: "e4" },
          { say: "Then press Continue.", ref: "e9" },
        ],
      },
    ]);
    expect(result).toMatchObject({ ok: true, notOnScreen: ["e9"] });
    await expect(
      tool?.execute({ goal: "x", steps: [] }, call) ?? Promise.resolve(),
    ).rejects.toThrow();
  });
});

describe("computer_request_help with point_at", () => {
  test("hands the ref to the gateway and still waits for the person", async () => {
    requests.length = 0;
    const tools = createHeadlessComputerTools({
      gateway,
      botId: "bot-1",
      actor,
    });
    const help = tools.find(
      (entry) => entry.definition.name === "computer_request_help",
    );
    expect(JSON.stringify(help?.definition.parameters)).toContain(
      POINT_AT_DESCRIPTION,
    );
    await expect(
      help?.execute({ reason: "Solve the puzzle", point_at: "e12" }, call) ??
        Promise.resolve(),
    ).rejects.toBeInstanceOf(HeadlessToolSuspension);
    expect(requests[0]?.slice(2)).toEqual([
      "Solve the puzzle",
      "call-1",
      { pointAt: "e12" },
    ]);
    await expect(
      help?.execute({ reason: "x", point_at: "not a ref!" }, call) ??
        Promise.resolve(),
    ).rejects.toThrow();
  });
});
