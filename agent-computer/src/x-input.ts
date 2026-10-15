import { spawn } from "node:child_process";
import {
  emptyKeycodes,
  keysymOfCharacter,
  runsOf,
  spareKeycodes,
} from "./x-keymap";

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
 * loaded, and what both use for typing text the US keymap has. A character it does not have (Greek,
 * an accented letter) the first types itself, on a spare keycode it binds and keeps bound
 * (`x-keymap.ts`); the fallback leaves it to xdotool, which borrows a keycode for the moment.
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
 * thing. A failure (xdotool missing, or exiting with an error) rejects that one call, so whoever
 * asked hears that nothing happened: the live screen tells the person, and Clicky reports the
 * action as not done instead of done. The queue itself carries on, and the next event is a fresh
 * try.
 */
function xdotoolRunner(display: string) {
  let queue: Promise<void> = Promise.resolve();
  const env = xdotoolEnvironment(display, process.env);
  return (args: string[], stdin?: string): Promise<void> => {
    const run = queue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn("xdotool", args, {
              env,
              stdio: [
                stdin === undefined ? "ignore" : "pipe",
                "ignore",
                "ignore",
              ],
            });
          } catch (error) {
            reject(xdotoolFailure(args, error));
            return;
          }
          child.on("error", (error) => reject(xdotoolFailure(args, error)));
          child.on("close", (code, signal) =>
            code === 0
              ? resolve()
              : reject(
                  xdotoolFailure(
                    args,
                    signal ? `stopped by ${signal}` : `exit code ${code}`,
                  ),
                ),
          );
          if (stdin !== undefined) child.stdin?.end(stdin);
        }),
    );
    queue = run.catch(() => undefined);
    return run;
  };
}

/** What failed, by the xdotool command alone: never the text it was typing. */
export function xdotoolFailure(args: readonly string[], cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `The desktop's input did not go through (xdotool ${args[0] ?? ""}: ${reason}).`,
  );
}

/**
 * What xdotool runs with: the display, and a UTF-8 locale. `xdotool type` reads its text in the
 * locale it is started in, and in the C locale every byte of a Greek letter is an "Invalid
 * multi-byte sequence": the whole text was dropped, silently, since its stderr goes nowhere.
 * `C.UTF-8` is built into the image's glibc, so it needs no locale package.
 */
export function xdotoolEnvironment(
  display: string,
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    DISPLAY: display,
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LC_CTYPE: "C.UTF-8",
    ...(source.XAUTHORITY ? { XAUTHORITY: source.XAUTHORITY } : {}),
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
 * How long a client is given to read a keycode's new binding before the first press of it. Only the
 * first: a binding is kept, so the same character typed again is pressed at once.
 */
const BINDING_SETTLES_MS = 20;

/**
 * Pointer and keys through libXtst; text the US keymap has through xdotool, and text it does not
 * have on spare keycodes bound here.
 *
 * Throws when the libraries cannot be opened or the display cannot, and the caller falls back.
 */
export async function xtestInput(display: string): Promise<XInput> {
  const { dlopen, FFIType, ptr, toArrayBuffer } = await import("bun:ffi");
  const x11 = dlopen("libX11.so.6", {
    XOpenDisplay: { args: [FFIType.ptr], returns: FFIType.ptr },
    XCloseDisplay: { args: [FFIType.ptr], returns: FFIType.i32 },
    XFlush: { args: [FFIType.ptr], returns: FFIType.i32 },
    XSync: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    XFree: { args: [FFIType.ptr], returns: FFIType.i32 },
    XStringToKeysym: { args: [FFIType.ptr], returns: FFIType.u64_fast },
    XKeysymToKeycode: {
      args: [FFIType.ptr, FFIType.u64],
      returns: FFIType.u8,
    },
    XDisplayKeycodes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    XGetKeyboardMapping: {
      args: [FFIType.ptr, FFIType.u8, FFIType.i32, FFIType.ptr],
      returns: FFIType.ptr,
    },
    XChangeKeyboardMapping: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
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

  /** The keysyms of `count` keycodes from `first`, read from the display rather than a cache. */
  const keymapOf = (
    first: number,
    count: number,
  ): { keysyms: bigint[]; perKeycode: number } => {
    const perKeycode = new Int32Array(1);
    const pointer = x11.symbols.XGetKeyboardMapping(
      connection,
      first,
      count,
      perKeycode,
    );
    const per = perKeycode[0] ?? 0;
    if (!pointer || per <= 0) return { keysyms: [], perKeycode: 0 };
    const keysyms = [
      ...new BigUint64Array(toArrayBuffer(pointer, 0, count * per * 8)),
    ];
    x11.symbols.XFree(pointer);
    return { keysyms, perKeycode: per };
  };

  // Found the first time a character needs one, from the keymap as the session left it.
  let spares: ReturnType<typeof spareKeycodes> | undefined;
  const sparesNow = () => {
    if (spares) return spares;
    const minimum = new Int32Array(1);
    const maximum = new Int32Array(1);
    x11.symbols.XDisplayKeycodes(connection, minimum, maximum);
    const low = minimum[0] || 8;
    const high = maximum[0] || 255;
    const { keysyms, perKeycode } = keymapOf(low, high - low + 1);
    spares = spareKeycodes(
      perKeycode ? emptyKeycodes(keysyms, perKeycode, low) : [],
    );
    return spares;
  };

  /** One character no key on the display types, on a spare keycode bound to it and left bound. */
  const typeUnmapped = async (character: string) => {
    const keysym = keysymOfCharacter(character);
    const slot = sparesNow().bind(keysym);
    if (!slot) {
      // Not one keycode spare: xdotool's moment of borrowing is better than nothing.
      await typeWith(run)(character);
      return;
    }
    // A binding kept from before can have gone with a keymap the session reloaded.
    const isBound =
      !slot.fresh &&
      Number(keymapOf(slot.keycode, 1).keysyms[0] ?? 0n) === keysym;
    if (!isBound) {
      // Both shift levels, so a held Shift (forwarded as a key of its own) changes nothing: the
      // surface already sent the character the person meant, capital or not.
      const levels = new BigUint64Array([BigInt(keysym), BigInt(keysym)]);
      x11.symbols.XChangeKeyboardMapping(
        connection,
        slot.keycode,
        2,
        levels,
        1,
      );
      x11.symbols.XSync(connection, 0);
      await new Promise((resolve) => setTimeout(resolve, BINDING_SETTLES_MS));
    }
    xtst.symbols.XTestFakeKeyEvent(connection, slot.keycode, 1, 0);
    xtst.symbols.XTestFakeKeyEvent(connection, slot.keycode, 0, 0);
    x11.symbols.XFlush(connection);
  };
  const typeOnKeymap = typeWith(run);

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
    async type(text) {
      for (const segment of runsOf(text)) {
        if (closed) return;
        if (segment.onKeymap) await typeOnKeymap(segment.text);
        else
          for (const character of segment.text) {
            try {
              await typeUnmapped(character);
            } catch (error) {
              // Said once a character, and typed the old way, which now has the locale it needs.
              console.warn(
                JSON.stringify({
                  type: "computer-desktop-type-fallback",
                  reason:
                    error instanceof Error ? error.message : String(error),
                }),
              );
              await typeOnKeymap(character);
            }
          }
      }
    },
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
