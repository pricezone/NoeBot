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
import { SendFailedNotice } from "@/components/channels/send-failed-notice";
import { settleReactWork } from "./settle-react-work";

/**
 * "FAILED TO SEND · RESEND · DISCARD", AND WHAT EACH WORD DOES.
 *
 * The fork has no per-message failed state: a send that fails never became a message, and the
 * composer puts the words back into the editor (`composer-send-failure.test.tsx` pins that). What
 * it had until now was nothing on screen SAYING so. The line lives in `ConversationView`, because
 * that is the component that owns both the send and the slot above the composer, and its two
 * actions reach into the composer through its handle — so the tests that matter are the ones
 * driven through `ConversationView` with a real composer under it, not the component alone.
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

test("the component says what happened and hands each word to its handler", () => {
  let resent = 0;
  let discarded = 0;
  const { getByRole, getByText } = render(
    <SendFailedNotice
      onResend={() => {
        resent += 1;
      }}
      onDiscard={() => {
        discarded += 1;
      }}
    />,
  );

  expect(getByRole("alert").textContent).toContain("Failed to send");
  expect(getByText("Failed to send").className).toContain("text-destructive");

  fireEvent.click(getByRole("button", { name: "Resend" }));
  fireEvent.click(getByRole("button", { name: "Discard" }));
  expect(resent).toBe(1);
  expect(discarded).toBe(1);
});

test("a refused send raises the line; Resend sends the restored words again and Discard clears them", async () => {
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

  // The words are back in the box AND the screen now says why.
  await waitFor(() => expect(queryByRole("alert")).not.toBeNull());
  expect(sent).toEqual(["ship it"]);
  expect(typedText(container)).toContain("ship it");

  // Resend goes through the composer's own path: the same draft, a second attempt, and — this
  // caller refusing everything — the line comes back for the second failure.
  await act(async () => {
    fireEvent.click(getByRole("button", { name: "Resend" }));
  });
  await waitFor(() => expect(sent).toEqual(["ship it", "ship it"]));
  await waitFor(() => expect(queryByRole("alert")).not.toBeNull());
  expect(typedText(container)).toContain("ship it");

  // Discard empties the editor and takes the line with it.
  await act(async () => {
    fireEvent.click(getByRole("button", { name: "Discard" }));
  });
  expect(typedText(container)).toBe("");
  expect(queryByRole("alert")).toBeNull();
  expect(sent).toHaveLength(2);
});

test("a send that goes through leaves no line behind", async () => {
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
