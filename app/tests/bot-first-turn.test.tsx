import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { frameFirstTurn } from "../../shared/first-turn";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { settleReactWork } from "./settle-react-work";

/**
 * A Bot made in one click speaks first. Its turn runs on the server and is opened with a message the
 * deployment wrote for it, which nobody typed and nobody should read; while the turn is running the
 * empty conversation says the Bot is thinking.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const FRAME = { id: "u0", role: "user" as const, content: frameFirstTurn() };

test("the first-turn frame is never drawn: the Bot speaks first", () => {
  const items = toVisibleChatItems([
    FRAME,
    { id: "a1", role: "assistant", content: "Hi! I'm New Bot." },
  ]);

  expect(items.map((item) => item.id)).toEqual(["a1"]);
});

test("an empty conversation with a turn running in it says the Bot is thinking", () => {
  const view = render(<ChatTranscript busy messages={[FRAME]} />);

  expect(view.getByRole("status").textContent).toBe("Thinking");
});

test("not while history is still being restored, and not when nothing is running", () => {
  const restoring = render(<ChatTranscript busy messages={[]} restoring />);
  expect(restoring.queryByText("Thinking")).toBeNull();
  restoring.unmount();

  const idle = render(<ChatTranscript messages={[FRAME]} />);
  expect(idle.queryByText("Thinking")).toBeNull();
});
