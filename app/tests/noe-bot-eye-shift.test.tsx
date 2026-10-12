import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import {
  type EyeShiftOptions,
  useEyeShift,
} from "@/components/noe-bot/anim/use-eye-shift";
import { NoeBotAvatar } from "@/components/noe-bot/noe-bot-avatar";

/*
 * The pointer's pull on a face's eyes, stepped by hand: animation frames are queued and flushed
 * here, and the svg is given the box and viewBox a real browser would report for a 32 px face at
 * the top-left of the page.
 */
let frames: FrameRequestCallback[] = [];
const originalRaf = globalThis.requestAnimationFrame;
const originalCaf = globalThis.cancelAnimationFrame;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
});
afterEach(() => {
  cleanup();
  frames = [];
});
afterAll(() => {
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCaf;
  GlobalRegistrator.unregister();
});

const flush = () =>
  act(() => {
    for (let i = 0; i < 400 && frames.length > 0; i++) {
      const due = frames;
      frames = [];
      for (const callback of due) callback(0);
    }
  });

function Face({
  reduced = false,
  options,
}: {
  reduced?: boolean;
  options: EyeShiftOptions;
}) {
  const [shift, ref] = useEyeShift(reduced, options);
  return (
    <svg
      data-shift={shift.join(",")}
      data-testid="face"
      ref={(node) => {
        if (node) {
          node.getBoundingClientRect = () =>
            ({
              left: 0,
              top: 0,
              width: 32,
              height: 32,
              right: 32,
              bottom: 32,
            }) as DOMRect;
          Object.defineProperty(node, "viewBox", {
            configurable: true,
            value: { baseVal: { x: -1, y: -2, width: 16, height: 16 } },
          });
        }
        ref(node);
      }}
      viewBox="-1 -2 16 16"
    />
  );
}

const pointer = (type: string, x: number, y: number) =>
  new window.PointerEvent(type, {
    clientX: x,
    clientY: y,
    pointerType: "mouse",
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("hovered, the eyes follow the pointer, keep following just after it leaves, then look ahead", async () => {
  const view = render(<Face options={{ follow: "hover", lingerMs: 60 }} />);
  const face = view.getByTestId("face");
  expect(face.dataset.shift).toBe("0,0");

  // Nothing happens to a face nobody is pointing at.
  act(() => {
    window.dispatchEvent(pointer("pointermove", 400, 16));
  });
  await flush();
  expect(face.dataset.shift).toBe("0,0");

  act(() => {
    face.dispatchEvent(pointer("pointerenter", 30, 16));
  });
  await flush();
  expect(face.dataset.shift).toBe("1,0");

  act(() => {
    window.dispatchEvent(pointer("pointermove", 2, 16));
  });
  await flush();
  expect(face.dataset.shift).toBe("-1,0");

  // Gone from the face, but still watched for the linger.
  act(() => {
    face.dispatchEvent(pointer("pointerleave", 2, 60));
    window.dispatchEvent(pointer("pointermove", 16, 400));
  });
  await flush();
  expect(face.dataset.shift).toBe("0,1");

  await sleep(100);
  await flush();
  expect(face.dataset.shift).toBe("0,0");
});

test("on the page, the eyes follow the pointer wherever it is, with no hover", async () => {
  const view = render(<Face options={{ follow: "page" }} />);
  const face = view.getByTestId("face");
  act(() => {
    window.dispatchEvent(pointer("pointermove", 1200, 16));
  });
  await flush();
  expect(face.dataset.shift).toBe("1,0");
  act(() => {
    window.dispatchEvent(pointer("pointermove", 16, -1200));
  });
  await flush();
  expect(face.dataset.shift).toBe("0,-1");
});

test("under reduced motion the eyes never move", async () => {
  const view = render(<Face options={{ follow: "page" }} reduced />);
  const face = view.getByTestId("face");
  act(() => {
    window.dispatchEvent(pointer("pointermove", 1200, 16));
  });
  await flush();
  expect(face.dataset.shift).toBe("0,0");
});

test("a touch is not a pointer to follow", async () => {
  const view = render(<Face options={{ follow: "page" }} />);
  const face = view.getByTestId("face");
  act(() => {
    window.dispatchEvent(
      new window.PointerEvent("pointermove", {
        clientX: 1200,
        clientY: 16,
        pointerType: "touch",
      }),
    );
  });
  await flush();
  expect(face.dataset.shift).toBe("0,0");
});

test("hovering an avatar moves its eye holes toward the pointer", async () => {
  // A roster-sized avatar at rest is its portrait, which no clock moves: whatever changes in the
  // drawing is the eyes.
  const view = render(
    <NoeBotAvatar color="#ff2056" expression="original" seed="a" size={32} />,
  );
  const svg = view.container.querySelector("svg") as SVGSVGElement;
  svg.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: 32,
      height: 32,
      right: 32,
      bottom: 32,
    }) as DOMRect;
  Object.defineProperty(svg, "viewBox", {
    configurable: true,
    value: { baseVal: { x: -1, y: -2, width: 16, height: 16 } },
  });
  const drawing = () =>
    [...svg.querySelectorAll("path")]
      .map((path) => path.getAttribute("d"))
      .join("|");
  const rest = drawing();
  act(() => {
    svg.dispatchEvent(pointer("pointerenter", 31, 16));
  });
  await flush();
  expect(drawing()).not.toBe(rest);
});
