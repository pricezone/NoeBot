import { describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startDesktopCast } from "../src/desktop-cast";
import type { InputMessage } from "../src/screencast";
import { clipboardWriter, type XInput } from "../src/x-input";
import { createDesktopKeyboard } from "../src/x-keyboard";

/**
 * A display that does with its events what X and xdotool do, so a test reads what came out on the
 * screen rather than which calls were made.
 *
 * A letter key types its letter, a capital while a Shift is down; with Control down it is a
 * shortcut, and Control+V pastes the clipboard. `type` is `xdotool type`: without
 * `--clearmodifiers` a held Control makes each character a shortcut, and after a capital it lets go
 * of Shift_L, as xdo does with the Shift it pressed for it.
 */
function fakeDisplay({ clipboard = true }: { clipboard?: boolean } = {}) {
  const down = new Set<string>();
  const screen: string[] = [];
  const typed: Array<{ text: string; clearModifiers: boolean }> = [];
  const state: { clipboard: string | undefined; closed: boolean } = {
    clipboard: undefined,
    closed: false,
  };
  const shift = () => down.has("Shift_L") || down.has("Shift_R");
  const control = () => down.has("Control_L") || down.has("Control_R");
  const isModifier = (keysym: string) =>
    /^(Shift|Control|Alt|Super)_[LR]$/.test(keysym);
  const input: XInput = {
    move: async () => undefined,
    button: async () => undefined,
    key: async (keysym, press) => {
      if (!press) {
        down.delete(keysym);
        return;
      }
      down.add(keysym);
      if (isModifier(keysym)) return;
      if (control()) {
        screen.push(
          keysym === "v" && state.clipboard !== undefined
            ? `paste:${state.clipboard}`
            : `Ctrl+${keysym}`,
        );
        return;
      }
      screen.push(shift() ? keysym.toUpperCase() : keysym);
    },
    type: async (text, options) => {
      const clear = options?.clearModifiers === true;
      typed.push({ text, clearModifiers: clear });
      for (const character of text) {
        if (!clear && control()) {
          screen.push(`Ctrl+${character.toLowerCase()}`);
          continue;
        }
        screen.push(character);
        if (!clear && character !== character.toLowerCase())
          down.delete("Shift_L");
      }
    },
    ...(clipboard
      ? {
          setClipboard: async (text: string) => {
            state.clipboard = text;
            return true;
          },
        }
      : {}),
    close: () => {
      state.closed = true;
    },
  };
  return { input, down, screen, typed, state };
}

const key = (
  event: "down" | "up",
  name: string,
  code: string,
  modifiers?: number,
): Extract<InputMessage, { type: "key" }> => ({
  type: "key",
  event,
  key: name,
  code,
  ...(modifiers === undefined ? {} : { modifiers }),
});

/** CDP's bits, as the surface sends them. Command arrives as Control. */
const SHIFT = 8;
const CONTROL = 2;

describe("the person's keyboard on the desktop", () => {
  test("Shift held and the A key type a capital A", async () => {
    const display = fakeDisplay();
    const keyboard = createDesktopKeyboard();
    await keyboard.key(display.input, key("down", "Shift", "ShiftLeft", SHIFT));
    await keyboard.key(display.input, key("down", "A", "KeyA", SHIFT));
    await keyboard.key(display.input, key("up", "A", "KeyA", SHIFT));
    await keyboard.key(display.input, key("up", "Shift", "ShiftLeft", 0));
    await keyboard.key(display.input, key("down", "b", "KeyB", 0));
    expect(display.screen).toEqual(["A", "b"]);
    expect(keyboard.held()).toEqual(["b"]);
  });

  test("a Shift whose press never arrived is pressed in step from the bitmask, and let go of after", async () => {
    const display = fakeDisplay();
    const keyboard = createDesktopKeyboard();
    await keyboard.key(display.input, key("down", "A", "KeyA", SHIFT));
    await keyboard.key(display.input, key("up", "A", "KeyA", SHIFT));
    // Its release went to another window: the next key says no Shift is held.
    await keyboard.key(display.input, key("down", "b", "KeyB", 0));
    expect(display.screen).toEqual(["A", "b"]);
    expect([...display.down]).toEqual(["b"]);
  });

  test("a Control left down is let go of before a key pressed without it", async () => {
    const display = fakeDisplay();
    const keyboard = createDesktopKeyboard();
    await keyboard.key(
      display.input,
      key("down", "Control", "ControlLeft", CONTROL),
    );
    await keyboard.key(display.input, key("down", "a", "KeyA", 0));
    expect(display.screen).toEqual(["a"]);
  });

  test("releasing the right Shift lets go of the left one pressed in step for it", async () => {
    const display = fakeDisplay();
    const keyboard = createDesktopKeyboard();
    await keyboard.key(display.input, key("down", "A", "KeyA", SHIFT));
    await keyboard.key(display.input, key("up", "A", "KeyA", SHIFT));
    await keyboard.key(display.input, key("up", "Shift", "ShiftRight", 0));
    expect(display.down.size).toBe(0);
  });

  test("Command+V pastes through the clipboard and Control+V, and no Control+letter is typed", async () => {
    const display = fakeDisplay();
    const keyboard = createDesktopKeyboard();
    // Command arrives as Control; the V stays in the person's browser and its paste comes as text.
    await keyboard.key(
      display.input,
      key("down", "Control", "ControlLeft", CONTROL),
    );
    await keyboard.text(display.input, {
      type: "text",
      text: "word",
      paste: true,
    });
    expect(display.state.clipboard).toBe("word");
    expect(display.screen).toEqual(["paste:word"]);
    expect(display.screen.some((typed) => typed === "Ctrl+w")).toBe(false);
    // Command is still held, so Control is down again, and its release lets go of it.
    expect([...display.down]).toEqual(["Control_L"]);
    await keyboard.key(display.input, key("up", "Control", "ControlLeft", 0));
    expect(display.down.size).toBe(0);
  });

  test("without a clipboard a paste is typed, every modifier cleared", async () => {
    const display = fakeDisplay({ clipboard: false });
    const keyboard = createDesktopKeyboard();
    await keyboard.key(
      display.input,
      key("down", "Control", "ControlLeft", CONTROL),
    );
    await keyboard.text(display.input, {
      type: "text",
      text: "word",
      paste: true,
    });
    expect(display.screen.join("")).toBe("word");
    expect(display.typed).toEqual([{ text: "word", clearModifiers: true }]);
    expect([...display.down]).toEqual(["Control_L"]);
  });

  test("text typed while Shift is held keeps the case of the keys after it", async () => {
    const display = fakeDisplay();
    const keyboard = createDesktopKeyboard();
    await keyboard.key(display.input, key("down", "Shift", "ShiftLeft", SHIFT));
    // A German Ä: the US key under the finger does not type it, so it is typed as text.
    await keyboard.key(display.input, key("down", "Ä", "Quote", SHIFT));
    await keyboard.key(display.input, key("up", "Ä", "Quote", SHIFT));
    await keyboard.key(display.input, key("down", "B", "KeyB", SHIFT));
    await keyboard.key(display.input, key("up", "B", "KeyB", SHIFT));
    // Text with no key behind it (an on-screen keyboard) does the same.
    await keyboard.text(display.input, { type: "text", text: "Hi" });
    await keyboard.key(display.input, key("down", "C", "KeyC", SHIFT));
    expect(display.screen.join("")).toBe("ÄBHiC");
    expect(display.typed.every((typed) => !typed.clearModifiers)).toBe(true);
  });

  test("releasing everything lets go of every held key, the last pressed first", async () => {
    const display = fakeDisplay();
    const keyboard = createDesktopKeyboard();
    const order: string[] = [];
    const key0 = display.input.key;
    display.input.key = async (keysym, press) => {
      if (!press) order.push(keysym);
      await key0(keysym, press);
    };
    await keyboard.key(
      display.input,
      key("down", "Control", "ControlLeft", CONTROL),
    );
    await keyboard.key(display.input, key("down", "a", "KeyA", CONTROL));
    await keyboard.releaseAll(display.input);
    expect(order).toEqual(["a", "Control_L"]);
    expect(display.down.size).toBe(0);
    expect(keyboard.held()).toEqual([]);
  });
});

/** A spawn for the cast's ffmpeg: a process that emits nothing and exits only when killed. */
function quietSpawn() {
  return ((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      args,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal?: string) {
        child.signalCode = signal ?? "SIGTERM";
        child.emit("exit", null);
        return true;
      },
    });
    return child;
  }) as unknown as typeof spawn;
}

describe("the desktop cast's keyboard", () => {
  const castOn = (display: ReturnType<typeof fakeDisplay>) =>
    startDesktopCast(
      {
        display: ":9",
        size: { width: 1440, height: 900 },
        onFrame: () => undefined,
        input: async () => display.input,
      },
      quietSpawn(),
    );

  test("a release (the window lost focus, the wheel went back) lets go of what is held", async () => {
    const display = fakeDisplay();
    const cast = castOn(display);
    await cast.send(key("down", "Shift", "ShiftLeft", SHIFT));
    await cast.send(key("down", "A", "KeyA", SHIFT));
    expect(display.down.size).toBe(2);
    await cast.send({ type: "release" });
    expect(display.down.size).toBe(0);
    // Typing goes on from nothing held.
    await cast.send(key("down", "b", "KeyB", 0));
    expect(display.screen).toEqual(["A", "b"]);
    await cast.stop();
  });

  test("stopping lets go of what is held before the display's connection closes", async () => {
    const display = fakeDisplay();
    const cast = castOn(display);
    await cast.send(key("down", "Control", "ControlLeft", CONTROL));
    await cast.stop();
    expect(display.down.size).toBe(0);
    expect(display.state.closed).toBe(true);
  });

  test("a release before any input opens no connection to the display", async () => {
    let opened = 0;
    const cast = startDesktopCast(
      {
        display: ":9",
        size: { width: 1440, height: 900 },
        onFrame: () => undefined,
        input: async () => {
          opened++;
          return fakeDisplay().input;
        },
      },
      quietSpawn(),
    );
    await cast.send({ type: "release" });
    await cast.stop();
    expect(opened).toBe(0);
  });

  test("a pasted text goes through the clipboard", async () => {
    const display = fakeDisplay();
    const cast = castOn(display);
    await cast.send({ type: "text", text: "γειά", paste: true });
    expect(display.state.clipboard).toBe("γειά");
    expect(display.screen).toEqual(["paste:γειά"]);
    await cast.stop();
  });
});

/** xclip as a child process: it reads its stdin and exits, or is not installed at all. */
function fakeXclip(outcome: "copied" | "missing") {
  const runs: Array<{ args: string[]; stdin: string; display?: string }> = [];
  const spawnImpl = ((
    _command: string,
    args: string[],
    options: { env?: Record<string, string> },
  ) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
    });
    if (outcome === "missing") {
      queueMicrotask(() =>
        child.emit("error", new Error("spawn xclip ENOENT")),
      );
      return child;
    }
    let stdin = "";
    child.stdin.on("data", (chunk: Buffer) => {
      stdin += String(chunk);
    });
    child.stdin.on("finish", () => {
      runs.push({
        args,
        stdin,
        ...(options.env?.DISPLAY ? { display: options.env.DISPLAY } : {}),
      });
      queueMicrotask(() => child.emit("exit", 0));
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, runs };
}

describe("the desktop's clipboard", () => {
  test("is set with xclip on stdin, the clipboard and the primary selection both", async () => {
    const xclip = fakeXclip("copied");
    const write = clipboardWriter(":9", {
      spawnImpl: xclip.spawnImpl,
      settleMs: 0,
    });
    expect(await write("-not an option")).toBe(true);
    expect(xclip.runs.map((run) => run.args.join(" ")).sort()).toEqual([
      "-selection clipboard",
      "-selection primary",
    ]);
    expect(xclip.runs.every((run) => run.stdin === "-not an option")).toBe(
      true,
    );
    expect(xclip.runs.every((run) => run.display === ":9")).toBe(true);
  });

  test("says it could not when xclip is not installed", async () => {
    const write = clipboardWriter(":9", {
      spawnImpl: fakeXclip("missing").spawnImpl,
      settleMs: 0,
    });
    expect(await write("word")).toBe(false);
  });
});
