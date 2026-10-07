/**
 * Renders the desktop's PNGs from the SVGs beside this file: the wallpaper and the dock's Chrome icon.
 *
 * Needs `sharp`, which this repository does not depend on. Run it from any directory where
 * `require("sharp")` resolves, naming this file:
 *
 *   node /path/to/NoeBot/docker/desktop/render.mjs
 *
 * THE WALLPAPER IS DITHERED. It is all soft grey gradients, and a gradient rendered straight to eight
 * bits per pixel is a stack of flat bands one grey level apart, which a dark screen shows as rings.
 * So the steps are blurred away in floating point and the result rounded back to eight bits with a
 * little noise, which turns each band edge into grain too fine to see. Rendered at the desktop's
 * own size, 1440x900, because resampling (xfdesktop's zoom) would round to eight bits again and
 * bring the bands back. Grey, so it is saved with one channel, which also keeps it small.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sharp = createRequire(join(process.cwd(), "noop.js"))("sharp");
const here = dirname(fileURLToPath(import.meta.url));

const WIDTH = 1440;
const HEIGHT = 900;
/** The drawing's margin, in its own units; see wallpaper.svg. */
const MARGIN = 240;
const DRAWN = { width: 2560, height: 1600 };

/** Three box blurs make a close enough Gaussian, in place, one axis at a time. */
function blur(values, width, height, radius) {
  const line = new Float32Array(Math.max(width, height));
  const pass = (count, length, at) => {
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < length; j++) line[j] = values[at(i, j)];
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += line[Math.min(length - 1, Math.max(0, k))];
      }
      for (let j = 0; j < length; j++) {
        values[at(i, j)] = sum / (2 * radius + 1);
        sum +=
          line[Math.min(length - 1, j + radius + 1)] -
          line[Math.max(0, j - radius)];
      }
    }
  };
  for (let round = 0; round < 3; round++) {
    pass(height, width, (y, x) => y * width + x);
    pass(width, height, (x, y) => y * width + x);
  }
}

async function wallpaper() {
  const scale = WIDTH / DRAWN.width;
  const { data } = await sharp(join(here, "wallpaper.svg"), {
    density: 72 * scale,
  })
    .extract({
      left: Math.round(MARGIN * scale),
      top: Math.round(MARGIN * scale),
      width: WIDTH,
      height: HEIGHT,
    })
    .flatten({ background: "#ffffff" })
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const values = Float32Array.from(data);
  blur(values, WIDTH, HEIGHT, 6);
  const out = Buffer.alloc(WIDTH * HEIGHT);
  // A fixed seed, so the same drawing renders to the same bytes.
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  for (let i = 0; i < values.length; i++) {
    const noise = random() + random() - 1;
    out[i] = Math.min(255, Math.max(0, Math.round(values[i] + noise)));
  }
  await sharp(out, { raw: { width: WIDTH, height: HEIGHT, channels: 1 } })
    .toColourspace("b-w")
    .png({ compressionLevel: 9 })
    .toFile(join(here, "wallpaper.png"));
}

async function chrome() {
  await sharp(join(here, "chrome.svg"))
    .resize(96, 96)
    .png({ compressionLevel: 9 })
    .toFile(join(here, "chrome.png"));
}

await Promise.all([wallpaper(), chrome()]);
console.log("rendered wallpaper.png and chrome.png");
