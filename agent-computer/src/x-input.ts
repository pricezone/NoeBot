import { spawn } from "node:child_process";

/**
 * A pointer and a keyboard for the desktop.
 *
 * The page screencast sends input through Chrome's own protocol, which reaches the page and nothing
 * else. A desktop needs input that reaches whatever window is under the pointer, the panel and the
 * terminal included, and that is the X server's job: the XTEST extension lets a client fake the
 * events a real mouse and keyboard would produce, and every window sees them as real.
 *
 * TWO WAYS IN, SAME SHAPE. The first talks to libXtst directly through Bun's FFI, which is one call
 * per event and no process to start: a pointer that follows the hand needs that. The second drives
 * `xdotool` as a child process, which is what the first falls back to when the library cannot be
 * loaded, and what both use for typing text, because xdotool knows how to type a character the
 * keymap does not have by borrowing a keycode for it.
 *
 * Nothing here decides whether input is allowed. `index.ts` asks the control state before any of it
 * is called, as it does for the page screencast.
 */
export type XInput = {
  move(x: number, y: number): Promise<void>;
  /** X button numbers: 1 left, 2 middle, 3 right, 4–7 the wheel. */
  button(button: number, press: boolean): Promise<void>;
  /** By keysym name: `a`, `Return`, `Shift_L`. */
  key(keysym: string, press: boolean): Promise<void>;
  /** Characters, whatever the keymap has. */
  type(text: string): Promise<void>;
  close(): void;
};

/**
 * One `xdotool` after another.
 *
 * Serialised, because input is ordered: a press that overtakes the move before it clicks the wrong
 * thing. Every failure is swallowed; the person sees the screen not react, and the next event is a
 * fresh try.
 */
function xdotoolRunner(display: string) {
  let queue: Promise<void> = Promise.resolve();
  const env = {
    DISPLAY: display,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
  };
  return (args: string[], stdin?: string): Promise<void> => {
    queue = queue
      .then(
        () =>
          new Promise<void>((resolve) => {
            const child = spawn("xdotool", args, {
              env,
              stdio: [
                stdin === undefined ? "ignore" : "pipe",
                "ignore",
                "ignore",
              ],
            });
            child.on("error", () => resolve());
            child.on("close", () => resolve());
            if (stdin !== undefined) child.stdin?.end(stdin);
          }),
      )
      .catch(() => undefined);
    return queue;
  };
}

/** Typing through xdotool, which maps characters the keymap lacks into a spare keycode. */
function typeWith(run: ReturnType<typeof xdotoolRunner>) {
  // From a file rather than an argument, so text beginning with a dash is text and not an option.
  return (text: string) =>
    text
      ? run(["type", "--delay", "2", "--file", "-"], text)
      : Promise.resolve();
}

/** Everything through xdotool. Slower by one process per event; needs no library. */
export function xdotoolInput(display: string): XInput {
  const run = xdotoolRunner(display);
  return {
    move: (x, y) => run(["mousemove", String(x), String(y)]),
    button: (button, press) =>
      run([press ? "mousedown" : "mouseup", String(button)]),
    key: (keysym, press) => run([press ? "keydown" : "keyup", keysym]),
    type: typeWith(run),
    close: () => undefined,
  };
}

/**
 * Pointer and keys through libXtst, text through xdotool.
 *
 * Throws when the libraries cannot be opened or the display cannot, and the caller falls back.
 */
export async function xtestInput(display: string): Promise<XInput> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const x11 = dlopen("libX11.so.6", {
    XOpenDisplay: { args: [FFIType.ptr], returns: FFIType.ptr },
    XCloseDisplay: { args: [FFIType.ptr], returns: FFIType.i32 },
    XFlush: { args: [FFIType.ptr], returns: FFIType.i32 },
    XStringToKeysym: { args: [FFIType.ptr], returns: FFIType.u64_fast },
    XKeysymToKeycode: {
      args: [FFIType.ptr, FFIType.u64],
      returns: FFIType.u8,
    },
  });
  const xtst = dlopen("libXtst.so.6", {
    XTestFakeMotionEvent: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.u64],
      returns: FFIType.i32,
    },
    XTestFakeButtonEvent: {
      args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u64],
      returns: FFIType.i32,
    },
    XTestFakeKeyEvent: {
      args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u64],
      returns: FFIType.i32,
    },
  });
  const cstring = (text: string) => ptr(Buffer.from(`${text}\0`, "utf8"));
  const connection = x11.symbols.XOpenDisplay(cstring(display));
  if (!connection) {
    x11.close();
    xtst.close();
    throw new Error(`The display ${display} could not be opened for input.`);
  }

  const run = xdotoolRunner(display);
  const keycodes = new Map<string, number>();
  const keycodeFor = (keysym: string): number => {
    const known = keycodes.get(keysym);
    if (known !== undefined) return known;
    const value = Number(x11.symbols.XStringToKeysym(cstring(keysym)));
    const keycode =
      value === 0 ? 0 : x11.symbols.XKeysymToKeycode(connection, value);
    keycodes.set(keysym, keycode);
    return keycode;
  };
  let closed = false;

  return {
    async move(x, y) {
      if (closed) return;
      xtst.symbols.XTestFakeMotionEvent(connection, -1, x, y, 0);
      x11.symbols.XFlush(connection);
    },
    async button(button, press) {
      if (closed) return;
      xtst.symbols.XTestFakeButtonEvent(connection, button, press ? 1 : 0, 0);
      x11.symbols.XFlush(connection);
    },
    async key(keysym, press) {
      if (closed) return;
      const keycode = keycodeFor(keysym);
      if (keycode === 0) {
        // Not in the keymap. xdotool borrows a keycode for it; slower, and correct.
        await run([press ? "keydown" : "keyup", keysym]);
        return;
      }
      xtst.symbols.XTestFakeKeyEvent(connection, keycode, press ? 1 : 0, 0);
      x11.symbols.XFlush(connection);
    },
    type: typeWith(run),
    close() {
      if (closed) return;
      closed = true;
      x11.symbols.XCloseDisplay(connection);
      x11.close();
      xtst.close();
    },
  };
}

/** The fast path when it can be had, said in the log either way. */
export async function openXInput(display: string): Promise<XInput> {
  try {
    const input = await xtestInput(display);
    console.info(
      JSON.stringify({ type: "computer-desktop-input", via: "xtest", display }),
    );
    return input;
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "computer-desktop-input",
        via: "xdotool",
        display,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    return xdotoolInput(display);
  }
}
