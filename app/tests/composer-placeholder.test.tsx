import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

/**
 * WHAT THE EMPTY EDITOR SAYS, AND WHO GETS TO DECIDE.
 *
 * The composer used to hard-code "Ask anything" in both of its layouts. The channel chat now names
 * the Bot instead — "Message Noë" — the way a messages app says who the words are going to, so the
 * hint is a prop with the old sentence as its default. Both layouts read the same prop; a hint
 * that changed only in the pill would be a second thing to keep in step.
 *
 * The harness is this repository's: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, `settleReactWork` before the document goes away (see that helper for why).
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

for (const variant of ["compact", "default"] as const) {
  test(`${variant}: an empty editor says "Ask anything" unless told otherwise`, () => {
    const { getByText, queryByText } = render(
      <Composer compact={variant === "compact"} onSubmit={() => {}} />,
    );
    expect(getByText("Ask anything")).toBeDefined();
    expect(queryByText("Message Noë")).toBeNull();
  });

  test(`${variant}: the caller's hint replaces the default`, () => {
    const { getByText, queryByText } = render(
      <Composer
        compact={variant === "compact"}
        onSubmit={() => {}}
        placeholder="Message Noë"
      />,
    );
    expect(getByText("Message Noë")).toBeDefined();
    expect(queryByText("Ask anything")).toBeNull();
  });
}

test("the hint goes away once there is something typed", () => {
  const { queryByText } = render(
    <Composer compact initialValue="hello" onSubmit={() => {}} />,
  );
  expect(queryByText("Ask anything")).toBeNull();
});
