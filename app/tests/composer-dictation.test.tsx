import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { deploymentKeys } from "@/lib/deployment/queries";
import * as recording from "@/lib/dictation/recording";
import { formatHotkey, getHotkey } from "@/lib/hotkeys/hotkeys";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(() => {
  cleanup();
  queryClient.clear();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

for (const variant of ["compact", "default"] as const) {
  for (const action of [
    "stop",
    "send",
    "retry-send",
    "failed-send",
    "cancel",
  ] as const) {
    test(`${variant} dictation: ${action} preserves the draft and follows the selected action`, async () => {
      queryClient.setQueryData(deploymentKeys.capabilities(), {
        generativeUi: true,
        transcription: true,
      });
      const audio = new Blob(["recording"], { type: "audio/webm" });
      const supported = spyOn(recording, "recordingSupported").mockReturnValue(
        true,
      );
      const start = spyOn(recording, "startRecording").mockResolvedValue({
        finish: async () => audio,
        cancel() {},
      });
      const result = Promise.withResolvers<string>();
      let attempts = 0;
      const transcribe = spyOn(
        recording,
        "transcribeRecording",
      ).mockImplementation(() => {
        if (action === "retry-send" && attempts++ === 0)
          return Promise.reject(new Error("Please retry transcription"));
        return result.promise;
      });
      const sent: string[] = [];
      try {
        const view = render(
          <Composer
            compact={variant === "compact"}
            initialValue="Existing draft"
            onSubmit={(draft) => {
              sent.push(draft.text);
              if (action === "failed-send")
                throw new Error("Agent unavailable");
            }}
          />,
        );
        fireEvent.click(
          view.getByRole("button", { name: "Dictate a message" }),
        );
        await waitFor(() => expect(view.getByText("Listening")).toBeDefined());
        expect(view.queryByRole("textbox", { name: "Message" })).toBeNull();
        expect(
          view.queryByRole("button", { name: "Dictate a message" }),
        ).toBeNull();
        expect(
          view.getByRole("img", { name: "Live audio waveform" }),
        ).toBeDefined();
        const form = view.container.querySelector("form");
        if (!form) throw new Error("Missing composer form");
        fireEvent.submit(form);
        expect(sent).toEqual([]);
        if (action === "cancel") {
          fireEvent.click(
            view.getByRole("button", { name: "Cancel dictation" }),
          );
          await waitFor(() =>
            expect(
              view.getByRole("textbox", { name: "Message" }).textContent,
            ).toBe("Existing draft"),
          );
          expect(transcribe).not.toHaveBeenCalled();
          expect(sent).toEqual([]);
          return;
        }
        fireEvent.click(
          view.getByRole("button", {
            name:
              action === "stop" ? "Stop and transcribe" : "Transcribe and send",
          }),
        );
        await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
        if (action === "retry-send") {
          await waitFor(() =>
            expect(view.getByRole("alert").textContent).toContain(
              "Please retry",
            ),
          );
          expect(sent).toEqual([]);
          fireEvent.click(view.getByRole("button", { name: "Retry" }));
          await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
        }
        fireEvent.submit(form);
        expect(sent).toEqual([]);
        await act(async () => {
          result.resolve("dictated words");
          await result.promise;
        });
        if (action === "stop" || action === "failed-send") {
          await waitFor(() =>
            expect(
              view.getByRole("textbox", { name: "Message" }).textContent,
            ).toContain("Existing draft dictated words"),
          );
        }
        if (action === "stop") {
          expect(sent).toEqual([]);
          fireEvent.submit(form);
        }
        await waitFor(() =>
          expect(sent).toEqual(["Existing draft dictated words"]),
        );
      } finally {
        cleanup();
        supported.mockRestore();
        start.mockRestore();
        transcribe.mockRestore();
      }
    });
  }
}

/**
 * The Mod+D shortcut, and when it is the composer's to take.
 *
 * `useHotkey` prevents the keystroke's default only when the handler says it acted, and Mod+D is
 * the browser's own bookmark shortcut. So the handler must decline — return `false` — wherever the
 * mic button would refuse, or a Composer on screen would make "bookmark this chat" do nothing on
 * every instance without transcription. It must also decline when the keystroke came from a field
 * that is not this composer: the combo skips the hook's editable check, and a Bot's instructions
 * typed into a dialog over a chat must not start the microphone in the composer underneath.
 */

/** Mod+D as this machine's keyboard sends it: the registry reads Cmd on a Mac and Ctrl elsewhere. */
const modD: KeyboardEventInit = {
  key: "d",
  code: "KeyD",
  ...(formatHotkey(getHotkey("dictate").combo)[0] === "⌘"
    ? { metaKey: true }
    : { ctrlKey: true }),
};

/** Dictation that can run: transcription on the instance, recording in the browser. */
function mockDictation() {
  const supported = spyOn(recording, "recordingSupported").mockReturnValue(
    true,
  );
  const start = spyOn(recording, "startRecording").mockResolvedValue({
    finish: async () => new Blob(["recording"], { type: "audio/webm" }),
    cancel() {},
  });
  return {
    start,
    restore() {
      supported.mockRestore();
      start.mockRestore();
    },
  };
}

test("Mod+D in the composer starts dictation once and takes the keystroke from the browser", async () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    transcription: true,
  });
  const dictation = mockDictation();
  try {
    const view = render(<Composer onSubmit={() => {}} />);
    const editor = view.getByRole("textbox", { name: "Message" });

    // `fireEvent` reports what `dispatchEvent` does: false once a listener prevented the default.
    expect(fireEvent.keyDown(editor, modD)).toBe(false);
    await waitFor(() => expect(view.getByText("Listening")).toBeDefined());
    expect(dictation.start).toHaveBeenCalledTimes(1);

    // Pressing it again while already recording is refused like the hidden mic button would be,
    // so the keystroke goes back to the browser rather than being swallowed.
    expect(fireEvent.keyDown(document.body, modD)).toBe(true);
    expect(dictation.start).toHaveBeenCalledTimes(1);
  } finally {
    dictation.restore();
  }
});

test("Mod+D in a field outside the composer neither starts dictation nor takes the keystroke", async () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    transcription: true,
  });
  const dictation = mockDictation();
  try {
    const view = render(
      <>
        <input aria-label="Search" type="text" />
        <Composer onSubmit={() => {}} />
      </>,
    );

    // A keystroke lands on the focused field, in a browser and in React's change tracking alike.
    const search = view.getByRole("textbox", { name: "Search" });
    search.focus();
    expect(fireEvent.keyDown(search, modD)).toBe(true);

    await settleReactWork();
    expect(dictation.start).not.toHaveBeenCalled();
    expect(view.queryByText("Listening")).toBeNull();
  } finally {
    dictation.restore();
  }
});

test("Mod+D while a modal is open over the composer is left alone", async () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    transcription: true,
  });
  const dictation = mockDictation();
  try {
    const view = render(
      <>
        <Composer onSubmit={() => {}} />
        <div aria-modal="true" role="dialog">
          <textarea aria-label="Instructions" />
        </div>
      </>,
    );

    // From the dialog's own field, and from the body where a modal that trapped focus leaves it.
    const instructions = view.getByRole("textbox", { name: "Instructions" });
    instructions.focus();
    expect(fireEvent.keyDown(instructions, modD)).toBe(true);
    instructions.blur();
    expect(fireEvent.keyDown(document.body, modD)).toBe(true);

    await settleReactWork();
    expect(dictation.start).not.toHaveBeenCalled();
    expect(view.queryByText("Listening")).toBeNull();
  } finally {
    dictation.restore();
  }
});

test("Mod+D on an instance without transcription leaves the browser's bookmark shortcut alone", async () => {
  queryClient.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: true,
    transcription: false,
  });
  const dictation = mockDictation();
  try {
    const view = render(<Composer onSubmit={() => {}} />);

    expect(
      fireEvent.keyDown(view.getByRole("textbox", { name: "Message" }), modD),
    ).toBe(true);
    expect(fireEvent.keyDown(document.body, modD)).toBe(true);

    await settleReactWork();
    expect(dictation.start).not.toHaveBeenCalled();
    expect(view.queryByText("Listening")).toBeNull();
  } finally {
    dictation.restore();
  }
});
