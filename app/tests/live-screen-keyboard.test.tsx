import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { LiveScreen } from "@/components/computer/live-screen";

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(_url: string) {
    SocketDouble.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

let originalWebSocket: typeof WebSocket;

beforeAll(() => {
  GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
});

afterEach(() => {
  cleanup();
  SocketDouble.latest = undefined;
});

afterAll(() => {
  globalThis.WebSocket = originalWebSocket;
  GlobalRegistrator.unregister();
});

async function liveSocket(): Promise<SocketDouble> {
  render(<LiveScreen computerId="keyboard-test" driving />);
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  return SocketDouble.latest as SocketDouble;
}

for (const [name, modifier] of [
  ["Ctrl+V", { ctrlKey: true }],
  ["Cmd+V", { metaKey: true }],
] as const) {
  test(`${name} stays in the local page so it can produce a paste event`, async () => {
    const socket = await liveSocket();
    const shortcut = new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      ...modifier,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(shortcut);

    expect(shortcut.defaultPrevented).toBe(false);
    expect(socket.sent).toEqual([]);
  });
}

/*
 * A layout that writes another script has no key that writes a V. Ctrl and the V key report "м" on
 * Russian and "ω" on Greek, with `code` still `KeyV`, so reading `key` alone sent the shortcut to the
 * remote browser and stopped the local paste event that carries the clipboard text.
 */
for (const [layout, written] of [
  ["Russian", "м"],
  ["Greek", "ω"],
] as const) {
  test(`Ctrl+V on a ${layout} layout stays in the local page too`, async () => {
    const socket = await liveSocket();
    const shortcut = new KeyboardEvent("keydown", {
      key: written,
      code: "KeyV",
      keyCode: 86,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(shortcut);
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: written,
        code: "KeyV",
        keyCode: 86,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(socket.sent).toEqual([]);
    expect(shortcut.defaultPrevented).toBe(false);
  });
}

test("Ctrl on a key that writes V on Dvorak is still paste, and Ctrl on the QWERTY V key is not", async () => {
  const socket = await liveSocket();
  // On Dvorak the key that writes V is the one QWERTY calls Period.
  const paste = new KeyboardEvent("keydown", {
    key: "v",
    code: "Period",
    keyCode: 86,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  // And the key QWERTY calls V writes K.
  const other = new KeyboardEvent("keydown", {
    key: "k",
    code: "KeyV",
    keyCode: 75,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });

  window.dispatchEvent(paste);
  window.dispatchEvent(other);

  expect(paste.defaultPrevented).toBe(false);
  expect(other.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "k",
      code: "KeyV",
      text: "k",
      windowsVirtualKeyCode: 75,
      modifiers: 2,
    },
  ]);
});

test("a paste keyup stays local when the modifier was released first", async () => {
  const socket = await liveSocket();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "v",
      code: "KeyV",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  window.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "v",
      code: "KeyV",
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(socket.sent).toEqual([]);
});

test("a period carries the browser's virtual key code to the remote screen", async () => {
  const socket = await liveSocket();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: ".",
      code: "Period",
      keyCode: 190,
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: ".",
      code: "Period",
      text: ".",
      windowsVirtualKeyCode: 190,
      modifiers: 0,
    },
  ]);
});

test("Ctrl+A remains a remote keyboard shortcut", async () => {
  const socket = await liveSocket();
  const shortcut = new KeyboardEvent("keydown", {
    key: "a",
    code: "KeyA",
    keyCode: 65,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });

  window.dispatchEvent(shortcut);

  expect(shortcut.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    },
  ]);
});

test("Command+A on a Mac reaches the Bot's Linux browser as Control+A", async () => {
  const socket = await liveSocket();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Meta",
      code: "MetaLeft",
      keyCode: 91,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      keyCode: 65,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(socket.sent).toEqual([
    {
      type: "key",
      event: "down",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      modifiers: 2,
    },
    {
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      text: "a",
      windowsVirtualKeyCode: 65,
      modifiers: 2,
    },
  ]);
});

test("the paste event sends clipboard text without forwarding it through a key event", async () => {
  const socket = await liveSocket();
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "." },
  });

  window.dispatchEvent(paste);

  expect(paste.defaultPrevented).toBe(true);
  expect(socket.sent).toEqual([{ type: "text", text: ".", paste: true }]);
});

test("a character with no key code behind it is sent as text, and its key-up stays here", async () => {
  // An on-screen or IME keyboard reports no `code`; the computer refuses a key message without one.
  const socket = await liveSocket();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ύ",
      code: "",
      bubbles: true,
      cancelable: true,
    }),
  );
  window.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "ύ",
      code: "",
      bubbles: true,
      cancelable: true,
    }),
  );

  expect(socket.sent).toEqual([{ type: "text", text: "ύ" }]);
});

/** `navigator.clipboard` for one test, restored after it. */
function stubClipboard(readText: () => Promise<string>): () => void {
  const had = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText },
  });
  return () => {
    if (had) Object.defineProperty(navigator, "clipboard", had);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  };
}

const commandV = () =>
  new KeyboardEvent("keydown", {
    key: "v",
    code: "KeyV",
    keyCode: 86,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });

test("Command+V with no paste event from the browser reads the clipboard and sends it as a paste", async () => {
  // Safari and a WKWebView may fire no paste event over a screen that is not a text field.
  const restore = stubClipboard(async () => "from the clipboard");
  try {
    const socket = await liveSocket();
    window.dispatchEvent(commandV());
    expect(socket.sent).toEqual([]);
    await waitFor(() =>
      expect(socket.sent).toEqual([
        { type: "text", text: "from the clipboard", paste: true },
      ]),
    );
  } finally {
    restore();
  }
});

test("when the paste event does come, its text is sent once and the clipboard is not read", async () => {
  let reads = 0;
  const restore = stubClipboard(async () => {
    reads++;
    return "read";
  });
  try {
    const socket = await liveSocket();
    window.dispatchEvent(commandV());
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "pasted" },
    });
    window.dispatchEvent(paste);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(reads).toBe(0);
    expect(socket.sent).toEqual([
      { type: "text", text: "pasted", paste: true },
    ]);
  } finally {
    restore();
  }
});

test("a key kept here under Command, whose keyup a Mac never sends, does not swallow the next press", async () => {
  const restore = stubClipboard(async () => "");
  try {
    const socket = await liveSocket();
    const press = (type: "keydown" | "keyup", init: KeyboardEventInit) =>
      window.dispatchEvent(
        new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }),
      );
    press("keydown", {
      key: "Meta",
      code: "MetaLeft",
      keyCode: 91,
      metaKey: true,
    });
    window.dispatchEvent(commandV());
    // No keyup for the V: Command was still held. Then Command goes up.
    press("keyup", { key: "Meta", code: "MetaLeft", keyCode: 91 });
    press("keydown", { key: "v", code: "KeyV", keyCode: 86 });
    press("keyup", { key: "v", code: "KeyV", keyCode: 86 });

    expect(socket.sent.filter((message) => message.code === "KeyV")).toEqual([
      {
        type: "key",
        event: "down",
        key: "v",
        code: "KeyV",
        text: "v",
        windowsVirtualKeyCode: 86,
        modifiers: 0,
      },
      {
        type: "key",
        event: "up",
        key: "v",
        code: "KeyV",
        windowsVirtualKeyCode: 86,
        modifiers: 0,
      },
    ]);
  } finally {
    restore();
  }
});

test("the window losing the focus lets go of every key on the Bot's computer", async () => {
  const socket = await liveSocket();
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Shift",
      code: "ShiftLeft",
      keyCode: 16,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  window.dispatchEvent(new Event("blur"));

  expect(socket.sent.at(-1)).toEqual({ type: "release" });
});

test("handing the wheel back lets go of every key on the Bot's computer", async () => {
  const view = render(<LiveScreen computerId="keyboard-test" driving />);
  await waitFor(() => expect(SocketDouble.latest).toBeDefined());
  const socket = SocketDouble.latest as SocketDouble;
  // Driving and ready: a key goes through.
  await waitFor(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Control",
        code: "ControlLeft",
        keyCode: 17,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(socket.sent.length).toBeGreaterThan(0);
  });

  view.rerender(<LiveScreen computerId="keyboard-test" driving={false} />);

  expect(socket.sent.at(-1)).toEqual({ type: "release" });
});
