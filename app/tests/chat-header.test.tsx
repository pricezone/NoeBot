import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ChatHeader } from "@/components/chat/chat-header";

/**
 * The one row of chrome above a conversation. The pill is the way to the Bot's details, the
 * toggle opens and closes the panel and says which it will do, and nothing else is drawn: no
 * gear, no "Computer" button, no wheel.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("the pill names the Bot and opens its details", () => {
  let pills = 0;
  let toggles = 0;
  const view = render(
    <ChatHeader
      agentIds={["bot-1"]}
      name="Noë"
      onPill={() => {
        pills += 1;
      }}
      onToggle={() => {
        toggles += 1;
      }}
      panelOpen={false}
    />,
  );
  const pill = view.getByRole("button", { name: "Open Noë" });
  expect(pill.textContent).toContain("Noë");
  fireEvent.click(pill);
  expect(pills).toBe(1);
  expect(toggles).toBe(0);
  expect(view.queryByRole("button", { name: "Take control" })).toBeNull();
  expect(view.queryByRole("button", { name: /computer/i })).toBeNull();
  expect(view.queryByRole("button", { name: "Channel coworker" })).toBeNull();
});

test("the toggle reports the panel's state and says what a press will do", () => {
  let toggles = 0;
  const props = {
    agentIds: ["bot-1"],
    name: "Noë",
    onPill: () => {},
    onToggle: () => {
      toggles += 1;
    },
  };
  const view = render(<ChatHeader {...props} panelOpen={false} />);
  const show = view.getByRole("button", { name: "Show details" });
  expect(show.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(show);
  expect(toggles).toBe(1);

  view.rerender(<ChatHeader {...props} panelOpen />);
  const hide = view.getByRole("button", { name: "Hide details" });
  expect(hide.getAttribute("aria-expanded")).toBe("true");
  expect(view.queryByRole("button", { name: "Show details" })).toBeNull();
});

test("a screen's own control rides along on the right", () => {
  const view = render(
    <ChatHeader
      agentIds={["bot-1"]}
      extra={<button type="button">New chat</button>}
      name="Noë"
      onPill={() => {}}
      onToggle={() => {}}
      panelOpen={false}
    />,
  );
  expect(view.getByRole("button", { name: "New chat" })).toBeTruthy();
});
