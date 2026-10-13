import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ComposerDraft } from "@/components/channels/composer";
import { ConversationView } from "@/components/channels/conversation-view";
import { settleReactWork } from "./settle-react-work";

/**
 * ONE CARD FOR ONE FAILED TURN, AND WHAT EACH OF ITS PILLS DOES.
 *
 * The fork has no per-message failed state: a send that fails never became a message, and the
 * composer puts the words back into the editor (`composer-send-failure.test.tsx` pins that). A
 * refused send used to raise "Failed to send · Resend · Discard" above the composer, and the turn
 * it belonged to, once started, a red sentence under the transcript: two surfaces, often at once,
 * for one failure. Now `ConversationView` hands the transcript one recovery card, and its pills
 * reach into the composer through its handle or out to the caller's `onRetry` — so the tests that
 * matter are driven through `ConversationView` with a real composer under it.
 *
 * NO `fetch` STUB AND NO CHANNEL, for the reason `composer-send-failure.test.tsx` gives: the
 * failure being driven is the caller's `onSubmit` rejecting, which is all a failed turn is from
 * here.
 *
 * The harness is this repository's: `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, `settleReactWork` before the document goes away.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector("[contenteditable]") as HTMLElement;
}

function typedText(container: HTMLElement): string {
  return editorOf(container).textContent ?? "";
}

/** Type by pasting plain text at the caret — the one way this suite can put words in the editor. */
function typeInto(container: HTMLElement, words: string) {
  const editor = editorOf(container);
  editor.focus();
  const caret = document.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(caret);
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      items: [],
      types: ["text/plain"],
      getData: (type: string) => (type === "text/plain" ? words : ""),
    },
  });
}

test("a refused send raises one card in the transcript; Retry sends the restored words again and Discard clears them", async () => {
  const sent: string[] = [];
  const view = render(
    <ConversationView
      messages={[]}
      onSubmit={(draft: ComposerDraft) => {
        sent.push(draft.text);
        return Promise.reject(new Error("the turn could not be started"));
      }}
    />,
  );
  const { container, getByLabelText, getByRole, queryByRole } = view;

  // Nothing to report before anything has been tried.
  expect(queryByRole("alert")).toBeNull();

  await act(async () => {
    typeInto(container, "ship it");
  });
  await act(async () => {
    fireEvent.click(getByLabelText("Send message"));
  });

  // The words are back in the box AND the transcript now says why, once, in the card.
  await waitFor(() => expect(queryByRole("alert")).not.toBeNull());
  expect(getByRole("alert").textContent).toContain("Your message wasn't sent.");
  expect(
    container.querySelector('[data-testid="transcript-stopped"]'),
  ).not.toBeNull();
  expect(sent).toEqual(["ship it"]);
  expect(typedText(container)).toContain("ship it");

  // Retry goes through the composer's own path: the same draft, a second attempt, and — this
  // caller refusing everything — the card comes back for the second failure.
  await act(async () => {
    fireEvent.click(getByRole("button", { name: "Retry" }));
  });
  await waitFor(() => expect(sent).toEqual(["ship it", "ship it"]));
  await waitFor(() => expect(queryByRole("alert")).not.toBeNull());
  expect(typedText(container)).toContain("ship it");

  // Discard empties the editor and takes the card with it.
  await act(async () => {
    fireEvent.click(getByRole("button", { name: "Discard" }));
  });
  expect(typedText(container)).toBe("");
  expect(queryByRole("alert")).toBeNull();
  expect(sent).toHaveLength(2);
});

test("a send that goes through leaves no card behind", async () => {
  const { container, getByLabelText, queryByRole } = render(
    <ConversationView messages={[]} onSubmit={() => Promise.resolve()} />,
  );

  await act(async () => {
    typeInto(container, "all good");
  });
  await act(async () => {
    fireEvent.click(getByLabelText("Send message"));
  });

  await waitFor(() => expect(typedText(container)).toBe(""));
  expect(queryByRole("alert")).toBeNull();
});

test("a turn that started and stopped is still one card, and Retry hands the turn back to the caller", async () => {
  let retried = 0;
  const reject = () => Promise.reject(new Error("the run failed"));
  const view = render(<ConversationView messages={[]} onSubmit={reject} />);
  const { container, getAllByRole, getByLabelText, getByRole } = view;

  await act(async () => {
    typeInto(container, "book the table");
  });
  await act(async () => {
    fireEvent.click(getByLabelText("Send message"));
  });
  await waitFor(() => expect(getAllByRole("alert")).toHaveLength(1));

  // The caller reports why the turn ended. Still one card, now in the caller's words.
  view.rerender(
    <ConversationView
      messages={[]}
      onRetry={() => {
        retried += 1;
      }}
      onSubmit={reject}
      stopped="The Bot stopped without saying why."
    />,
  );
  await waitFor(() =>
    expect(getByRole("alert").textContent).toContain(
      "The Bot stopped without saying why.",
    ),
  );
  expect(getAllByRole("alert")).toHaveLength(1);
  expect(view.queryByRole("button", { name: "Discard" })).toBeNull();

  // Retry runs the turn again through the caller, and the words the composer took back go: the
  // message is already in the transcript, and sending them as well would say it twice.
  await act(async () => {
    fireEvent.click(getByRole("button", { name: "Retry" }));
  });
  expect(retried).toBe(1);
  expect(typedText(container)).toBe("");
});

test("a stopped turn with nothing to retry it through can still be dismissed", async () => {
  const view = render(
    <ConversationView
      messages={[]}
      onSubmit={() => Promise.resolve()}
      stopped="Another run is still in progress on this conversation. Wait for it to finish, then try again."
    />,
  );
  expect(view.getByRole("alert").textContent).toContain(
    "Another run is still in progress",
  );
  expect(view.queryByRole("button", { name: "Retry" })).toBeNull();

  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
  });
  expect(view.queryByRole("alert")).toBeNull();
});

test("the card speaks the person's language", async () => {
  const view = render(
    <ConversationView
      messages={[{ id: "u1", role: "user", content: "Κλείσε τραπέζι για δύο" }]}
      onRetry={() => undefined}
      onSubmit={() => Promise.resolve()}
      stopped="The Bot stopped without saying why."
    />,
  );
  expect(view.getByRole("alert").textContent).toContain(
    "Ο Bot σταμάτησε χωρίς να πει γιατί.",
  );
  expect(view.getByRole("button", { name: "Δοκίμασε ξανά" })).toBeTruthy();
});
