import { describe, expect, test } from "bun:test";
import {
  createMjpegSplitter,
  ffmpegGrabArguments,
  startDesktopCast,
  streamSettingsFromEnv,
} from "../src/desktop-cast";
import type { FrameMessage } from "../src/screencast";
import type { XInput } from "../src/x-input";

const jpeg = (body: string) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from(body),
    Buffer.from([0xff, 0xd9]),
  ]);

describe("the JPEG splitter", () => {
  test("hands back each frame of a stream, whole", () => {
    const frames: Buffer[] = [];
    const splitter = createMjpegSplitter((frame) => frames.push(frame));
    splitter.push(Buffer.concat([jpeg("one"), jpeg("two")]));
    expect(frames.map(String)).toEqual([
      String(jpeg("one")),
      String(jpeg("two")),
    ]);
  });

  test("waits for a frame cut across chunks, even inside a marker", () => {
    const frames: Buffer[] = [];
    const splitter = createMjpegSplitter((frame) => frames.push(frame));
    const whole = jpeg("split");
    splitter.push(whole.subarray(0, 1)); // just the FF of SOI
    splitter.push(whole.subarray(1, 4));
    splitter.push(whole.subarray(4, whole.length - 1)); // ends on the FF of EOI
    expect(frames).toHaveLength(0);
    splitter.push(whole.subarray(whole.length - 1));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.equals(whole)).toBe(true);
  });

  test("drops bytes that belong to no frame", () => {
    const frames: Buffer[] = [];
    const splitter = createMjpegSplitter((frame) => frames.push(frame));
    splitter.push(Buffer.concat([Buffer.from("noise"), jpeg("x")]));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.equals(jpeg("x"))).toBe(true);
  });
});

describe("the ffmpeg grab", () => {
  test("streams the display at its size, ten times a second, to a pipe", () => {
    const args = ffmpegGrabArguments(":9", { width: 1440, height: 900 });
    expect(args).toContain("x11grab");
    expect(args.slice(args.indexOf("-video_size"))[1]).toBe("1440x900");
    expect(args.slice(args.indexOf("-i"))[1]).toBe(":9");
    expect(args.slice(args.indexOf("-framerate"))[1]).toBe("10");
    // Measured to hold the first frame back until the screen changed; the cast dedupes instead.
    expect(args.join(" ")).not.toContain("mpdecimate");
    expect(args.at(-1)).toBe("-");
  });

  test("can scale the picture down and change its quality, and says nothing of either by default", () => {
    const plain = ffmpegGrabArguments(":9", { width: 1440, height: 900 });
    expect(plain).not.toContain("-vf");
    expect(plain.slice(plain.indexOf("-q:v"))[1]).toBe("5");

    const smaller = ffmpegGrabArguments(
      ":9",
      { width: 1440, height: 900 },
      { stream: { scale: { width: 1280, height: 800 }, quality: 6 } },
    );
    // Grabbed at the screen's size, so the whole screen is in it; scaled before it is encoded.
    expect(smaller.slice(smaller.indexOf("-video_size"))[1]).toBe("1440x900");
    expect(smaller.slice(smaller.indexOf("-vf"))[1]).toBe(
      "scale=1280:800:flags=fast_bilinear",
    );
    expect(smaller.slice(smaller.indexOf("-q:v"))[1]).toBe("6");
  });

  test("reads the stream settings from the environment, and refuses what it cannot use", () => {
    const screen = { width: 1440, height: 900 };
    expect(streamSettingsFromEnv({}, screen)).toEqual({
      scale: null,
      quality: 5,
    });
    expect(
      streamSettingsFromEnv(
        {
          COMPUTER_DESKTOP_STREAM_SIZE: "1280x800",
          COMPUTER_DESKTOP_STREAM_QUALITY: "7",
        },
        screen,
      ),
    ).toEqual({ scale: { width: 1280, height: 800 }, quality: 7 });
    // Larger than the screen, nonsense, out of range: the defaults.
    expect(
      streamSettingsFromEnv(
        {
          COMPUTER_DESKTOP_STREAM_SIZE: "2560x1600",
          COMPUTER_DESKTOP_STREAM_QUALITY: "99",
        },
        screen,
      ),
    ).toEqual({ scale: null, quality: 5 });
    expect(
      streamSettingsFromEnv({ COMPUTER_DESKTOP_STREAM_SIZE: "big" }, screen)
        .scale,
    ).toBeNull();
  });

  test("a single capture asks for one frame", () => {
    const args = ffmpegGrabArguments(
      ":9",
      { width: 800, height: 600 },
      { once: true },
    );
    expect(args.join(" ")).toContain("-frames:v 1");
    expect(args).not.toContain("-framerate");
  });

  test("leaves the display's own pointer out of the stream and of a screenshot", () => {
    const size = { width: 1440, height: 900 };
    for (const args of [
      ffmpegGrabArguments(":9", size),
      ffmpegGrabArguments(":9", size, { once: true }),
    ]) {
      expect(args.slice(args.indexOf("-draw_mouse"))[1]).toBe("0");
      expect(args.join(" ")).not.toContain("-draw_mouse 1");
    }
  });
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/** A spawn whose processes emit what the test writes and exit only when killed. */
function fakeSpawn() {
  const children: Array<
    EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      args: string[];
      exitCode: number | null;
      signalCode: string | null;
      kill: (signal?: string) => boolean;
    }
  > = [];
  const spawnImpl = ((_command: string, args: string[]) => {
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
    children.push(child);
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, children };
}

describe("the desktop cast", () => {
  test("turns the person's input into pointer and key events on the display", async () => {
    const calls: string[] = [];
    const input: XInput = {
      move: async (x, y) => void calls.push(`move ${x},${y}`),
      button: async (button, press) =>
        void calls.push(`${press ? "press" : "release"} ${button}`),
      key: async (keysym, press) =>
        void calls.push(`${press ? "keydown" : "keyup"} ${keysym}`),
      type: async (text) => void calls.push(`type ${text}`),
      close: () => void calls.push("close"),
    };
    const { spawnImpl } = fakeSpawn();
    const frames: FrameMessage[] = [];
    const cast = startDesktopCast(
      {
        display: ":9",
        size: { width: 1440, height: 900 },
        onFrame: (frame) => frames.push(frame),
        input: async () => input,
      },
      spawnImpl,
    );

    await cast.send({ type: "mouse", event: "moved", x: 10.4, y: 20.6 });
    await cast.send({
      type: "mouse",
      event: "pressed",
      x: 10,
      y: 21,
      button: "right",
    });
    await cast.send({
      type: "mouse",
      event: "released",
      x: 10,
      y: 21,
      button: "right",
    });
    await cast.send({ type: "wheel", x: 5, y: 5, deltaX: 0, deltaY: -100 });
    await cast.send({
      type: "key",
      event: "down",
      key: "Shift",
      code: "ShiftLeft",
    });
    await cast.send({
      type: "key",
      event: "down",
      key: "A",
      code: "KeyA",
      text: "A",
    });
    await cast.send({ type: "key", event: "up", key: "A", code: "KeyA" });
    await cast.send({
      type: "key",
      event: "up",
      key: "Shift",
      code: "ShiftLeft",
    });
    await cast.send({
      type: "key",
      event: "down",
      key: "α",
      code: "KeyA",
      text: "α",
    });
    await cast.send({ type: "key", event: "up", key: "α", code: "KeyA" });
    await cast.send({ type: "text", text: "pasted" });
    await cast.stop();

    expect(calls).toEqual([
      "move 10,21",
      "move 10,21",
      "press 3",
      "move 10,21",
      "release 3",
      "move 5,5",
      "press 4",
      "release 4",
      "keydown Shift_L",
      "keydown a",
      "keyup a",
      "keyup Shift_L",
      "type α",
      "type pasted",
      "close",
    ]);
    expect(frames).toEqual([]);
  });

  test("frames carry the display's size, and none arrive once stopped", async () => {
    const { spawnImpl, children } = fakeSpawn();
    const frames: FrameMessage[] = [];
    const cast = startDesktopCast(
      {
        display: ":9",
        size: { width: 1440, height: 900 },
        onFrame: (frame) => frames.push(frame),
        input: async () => {
          throw new Error("not driven");
        },
      },
      spawnImpl,
    );
    const grabber = children[0];
    expect(grabber?.args).toContain("x11grab");

    grabber?.stdout.write(jpeg("first"));
    // The same screen again is not a new frame.
    grabber?.stdout.write(jpeg("first"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "frame",
      width: 1440,
      height: 900,
      data: jpeg("first").toString("base64"),
    });

    grabber?.stdout.write(jpeg("second"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toHaveLength(2);

    await cast.stop();
    expect(grabber?.signalCode).toBe("SIGTERM");
    grabber?.stdout.write(jpeg("late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toHaveLength(2);
    // Input never opened, so nothing to close; a stopped cast ignores what it is sent.
    await cast.send({ type: "text", text: "ignored" });
  });
});
