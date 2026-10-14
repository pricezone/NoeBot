import { type ChildProcess, spawn } from "node:child_process";
import type { FrameMessage, InputMessage, Screencast } from "./screencast";
import type { DisplaySize } from "./virtual-display";
import { openXInput, type XInput } from "./x-input";
import { wheelClicks, xKeyFor } from "./x-keys";

/**
 * The live screen of a desktop, in the same shape as the live screen of a page.
 *
 * `screencast.ts` asks Chrome for frames of one page and sends input back to that page through
 * Chrome. This asks the X server for frames of the whole display, through ffmpeg's `x11grab`, and
 * sends input back to the display through XTEST. What goes over the socket is identical: the same
 * `{type:"frame"}` messages out, the same mouse, wheel, key and text messages in. The server relay
 * and the browser client do not know which one they are talking to, which is why neither changed.
 *
 * FRAMES WHEN SOMETHING MOVES. ffmpeg grabs ten times a second and encodes every grab; a frame whose
 * bytes equal the last one sent is dropped here, so a desktop nobody is touching costs the encode
 * and no bandwidth, and a page scrolling by costs ten frames a second, which is what a person
 * steering it needs. The encoder is deterministic at a fixed quality, so an unchanged screen is an
 * identical JPEG. Not ffmpeg's own `mpdecimate`, which was measured to hold the first frame back
 * until the screen changed: a person opening a quiet desktop saw nothing until they moved the mouse.
 *
 * COORDINATES ARE SCREEN PIXELS. A frame is the whole display at its own size, so the client's
 * frame-relative coordinates are screen coordinates, and that is what XTEST takes. There is no
 * viewport to offset by: the browser window is just one window on the screen.
 */

/** JPEG quality, ffmpeg's scale: 2 is best, 31 worst. 5 reads text well at the sizes this streams. */
const JPEG_QUALITY = "5";
const FRAME_RATE = "10";
const STOP_BUDGET_MS = 2_000;
const ONE_FRAME_BUDGET_MS = 5_000;
const MAX_RESTARTS = 3;

/**
 * How the stream is encoded: an optional smaller size to scale to before encoding, and the JPEG
 * quality. The frame still says the screen's size, so the viewer maps a click to screen pixels
 * whatever size the picture is.
 */
export type StreamSettings = { scale: DisplaySize | null; quality: number };

export const DEFAULT_STREAM: StreamSettings = {
  scale: null,
  quality: Number(JPEG_QUALITY),
};

/**
 * `COMPUTER_DESKTOP_STREAM_SIZE` (`WIDTHxHEIGHT`, no larger than the screen) and
 * `COMPUTER_DESKTOP_STREAM_QUALITY` (2 best to 31 worst). Anything unreadable keeps the default.
 */
export function streamSettingsFromEnv(
  env: NodeJS.ProcessEnv,
  screen: DisplaySize,
): StreamSettings {
  const size = /^(\d{3,4})x(\d{3,4})$/.exec(
    env.COMPUTER_DESKTOP_STREAM_SIZE?.trim() ?? "",
  );
  const width = Number(size?.[1]);
  const height = Number(size?.[2]);
  const scale =
    size && width <= screen.width && height <= screen.height
      ? { width, height }
      : null;
  const quality = Number(env.COMPUTER_DESKTOP_STREAM_QUALITY?.trim());
  return {
    scale,
    quality:
      Number.isInteger(quality) && quality >= 2 && quality <= 31
        ? quality
        : DEFAULT_STREAM.quality,
  };
}

/** The grab, as ffmpeg's arguments. `once` captures one frame and exits; otherwise it streams. */
export function ffmpegGrabArguments(
  display: string,
  size: DisplaySize,
  {
    once = false,
    stream = DEFAULT_STREAM,
    keep,
  }: {
    once?: boolean;
    stream?: StreamSettings;
    /**
     * The part of the screen left visible, everything else drawn black (Clicky's model sees only
     * the Bot's page). Empty blacks out the whole frame.
     */
    keep?: { x: number; y: number; width: number; height: number } | null;
  } = {},
): string[] {
  const filters = [
    ...(keep ? keepFilters(keep, size) : []),
    ...(stream.scale
      ? [
          `scale=${stream.scale.width}:${stream.scale.height}:flags=fast_bilinear`,
        ]
      : []),
  ];
  return [
    "-nostdin",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    ...(once ? [] : ["-framerate", FRAME_RATE]),
    "-video_size",
    `${size.width}x${size.height}`,
    // The display's own pointer left out of the picture. Drawn in, a person watching saw two arrows,
    // that one and their own, and their own is the only one they should see, as in Grok; the Bot
    // never needs the system pointer in a screenshot. A pointer moving over a still screen also no
    // longer changes the frame, so the dedupe below sends nothing for it.
    "-draw_mouse",
    "0",
    "-i",
    display,
    ...(once ? ["-frames:v", "1"] : []),
    ...(filters.length > 0 ? ["-vf", filters.join(",")] : []),
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-q:v",
    String(stream.quality),
    "-",
  ];
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * JPEGs out of a byte stream.
 *
 * ffmpeg's `image2pipe` writes one JPEG after another with nothing between them. Each starts with
 * the SOI marker and ends with EOI, and inside a baseline JPEG an `FF` byte is always followed by
 * `00` or a restart marker, so `FF D9` cannot occur before the end. Bytes before the first SOI are
 * noise and dropped; a frame cut by a chunk boundary waits for the rest.
 */
export function createMjpegSplitter(onFrame: (jpeg: Buffer) => void) {
  let pending: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let from = 0;
      for (;;) {
        const start = pending.indexOf(SOI, from);
        if (start < 0) {
          // Keep a trailing FF: it may be the first half of the next SOI.
          const last = pending.length - 1;
          pending =
            last >= 0 && pending[last] === 0xff
              ? pending.subarray(last)
              : Buffer.alloc(0);
          return;
        }
        const end = pending.indexOf(EOI, start + 2);
        if (end < 0) {
          pending = pending.subarray(start);
          return;
        }
        onFrame(pending.subarray(start, end + 2));
        from = end + 2;
      }
    },
  };
}

type Spawn = typeof spawn;

/** One frame of the display, as a JPEG. */
export function captureDesktopFrame(
  display: string,
  size: DisplaySize,
  spawnImpl: Spawn = spawn,
  /**
   * A smaller size to scale the one frame to: the phone's thumbnail, or the frame Clicky's model
   * looks at. Absent, the screen's own size, as the panel's preview always had.
   */
  scale?: DisplaySize | null,
  /** The part left visible, the rest black (see `ffmpegGrabArguments`). Absent shows all of it. */
  keep?: { x: number; y: number; width: number; height: number } | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      "ffmpeg",
      ffmpegGrabArguments(display, size, {
        once: true,
        ...(scale ? { stream: { ...DEFAULT_STREAM, scale } } : {}),
        ...(keep ? { keep } : {}),
      }),
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The desktop did not produce a frame in time."));
    }, ONE_FRAME_BUDGET_MS);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const frame = Buffer.concat(chunks);
      if (code !== 0 || frame.length === 0) {
        reject(
          new Error(
            `The desktop could not be captured (ffmpeg exit ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}).`,
          ),
        );
        return;
      }
      resolve(frame);
    });
  });
}

/**
 * ffmpeg filters that keep one rectangle of the frame and black out the rest: cut the rectangle
 * out, then pad it back to the screen's size at the same place. Even numbers, which the JPEG
 * encoder's chroma subsampling asks for; an empty rectangle fills the whole frame black.
 */
export function keepFilters(
  keep: { x: number; y: number; width: number; height: number },
  size: DisplaySize,
): string[] {
  // Inward to even numbers, so not one pixel outside the rectangle is kept.
  const up = (value: number) => Math.max(0, Math.ceil(value / 2) * 2);
  const down = (value: number) => Math.max(0, Math.floor(value / 2) * 2);
  const x = Math.min(up(keep.x), size.width);
  const y = Math.min(up(keep.y), size.height);
  const width = Math.max(
    0,
    down(Math.min(keep.x + keep.width, size.width)) - x,
  );
  const height = Math.max(
    0,
    down(Math.min(keep.y + keep.height, size.height)) - y,
  );
  if (width < 2 || height < 2)
    return ["drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill"];
  return [
    `crop=${width}:${height}:${x}:${y}`,
    `pad=${size.width}:${size.height}:${x}:${y}:black`,
  ];
}

/**
 * Cast the display to `onFrame`, and return a handle that accepts input.
 *
 * Same contract as `startScreencast`, so the viewer claim in `viewer.ts` installs, replaces and
 * stops it without knowing the difference.
 */
export function startDesktopCast(
  {
    display,
    size,
    onFrame,
    input: openInput = openXInput,
    stream = DEFAULT_STREAM,
  }: {
    display: string;
    size: DisplaySize;
    onFrame: (frame: FrameMessage) => void;
    input?: (display: string) => Promise<XInput>;
    stream?: StreamSettings;
  },
  spawnImpl: Spawn = spawn,
): Screencast {
  let stopped = false;
  let grabber: ChildProcess | undefined;
  let restarts = 0;

  let last: Buffer | undefined;
  const splitter = createMjpegSplitter((jpeg) => {
    if (stopped) return;
    if (last?.equals(jpeg)) return;
    last = Buffer.from(jpeg);
    onFrame({
      type: "frame",
      data: jpeg.toString("base64"),
      width: size.width,
      height: size.height,
    });
  });

  const startGrabber = () => {
    if (stopped) return;
    const child = spawnImpl(
      "ffmpeg",
      ffmpegGrabArguments(display, size, { stream }),
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    grabber = child;
    child.stdout?.on("data", (chunk: Buffer) => splitter.push(chunk));
    let said = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      if (said++ > 10) return;
      console.warn(
        JSON.stringify({
          type: "computer-desktop-cast-stderr",
          line: String(chunk).trim(),
        }),
      );
    });
    child.on("error", () => undefined);
    child.on("exit", (code) => {
      if (grabber === child) grabber = undefined;
      if (stopped) return;
      restarts++;
      console.error(
        JSON.stringify({
          type: "computer-desktop-cast-exited",
          exitCode: code,
          restarting: restarts <= MAX_RESTARTS,
        }),
      );
      if (restarts <= MAX_RESTARTS) setTimeout(startGrabber, 1_000);
    });
  };
  startGrabber();

  /*
   * Opened on the first input rather than at start, because most screens are watched and never
   * driven, and an X client per watcher is a connection the server keeps for nothing.
   */
  let input: Promise<XInput> | undefined;
  const inputFor = () => {
    input ??= openInput(display);
    return input;
  };

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      const child = grabber;
      grabber = undefined;
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
        child.kill("SIGTERM");
        const stoppedInTime = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), STOP_BUDGET_MS),
          ),
        ]);
        if (!stoppedInTime) child.kill("SIGKILL");
      }
      if (input) (await input).close();
    },

    async send(message: InputMessage) {
      if (stopped) return;
      const x = await inputFor();
      if (message.type === "mouse") {
        const px = Math.round(message.x);
        const py = Math.round(message.y);
        await x.move(px, py);
        if (message.event === "moved") return;
        const button =
          message.button === "right" ? 3 : message.button === "middle" ? 2 : 1;
        await x.button(button, message.event === "pressed");
        return;
      }

      if (message.type === "wheel") {
        await x.move(Math.round(message.x), Math.round(message.y));
        for (const click of wheelClicks(message.deltaX, message.deltaY)) {
          for (let n = 0; n < click.times; n++) {
            await x.button(click.button, true);
            await x.button(click.button, false);
          }
        }
        return;
      }

      if (message.type === "key") {
        const key = xKeyFor(message);
        if (key.kind === "keysym") {
          await x.key(key.keysym, message.event === "down");
        } else if (key.kind === "text" && message.event === "down") {
          await x.type(key.text);
        }
        return;
      }

      await x.type(message.text);
    },
  };
}
