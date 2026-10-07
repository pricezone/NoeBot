/**
 * Renders the desktop's PNGs from the SVGs beside this file: the wallpaper and the dock's Chrome icon.
 *
 * Needs `sharp`, which this repository does not depend on. Run it from any directory where
 * `require("sharp")` resolves, naming this file:
 *
 *   node /path/to/NoeBot/docker/desktop/render.mjs
 *
 * THE WALLPAPER'S SKY IS SMOOTHED AND DITHERED. It is wide soft gradients, and a gradient rendered
 * straight to eight bits per pixel is a stack of flat bands one level apart, which shows as rings.
 * So the sky (between the `sky` markers in wallpaper.svg) is rendered on its own and blurred in
 * floating point; the scene (stars, arrows, hills, between the `scene` markers) is rendered on its
 * own, transparent, and laid over it unblurred so its edges stay crisp; and the result is rounded
 * back to eight bits with a fine grey grain, which hides what is left of any band. Rendered at the
 * desktop's own size, 1440x900, because resampling (xfdesktop's zoom) would round to eight bits again.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sharp = createRequire(join(process.cwd(), "noop.js"))("sharp");
const here = dirname(fileURLToPath(import.meta.url));

const WIDTH = 1440;
const HEIGHT = 900;
/** How far the sky is smoothed, as a box radius in pixels (three passes make it near Gaussian). */
const SKY_BLUR = 6;
/** The grain's height, in eight-bit levels either side. */
const GRAIN = 1.6;

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

/** One part of wallpaper.svg: the other part's markers and everything between them taken out. */
function part(source, drop) {
  const marked = new RegExp(`<!-- ${drop} -->[\\s\\S]*<!-- /${drop} -->`);
  if (!marked.test(source)) throw new Error(`wallpaper.svg has no ${drop} markers`);
  return Buffer.from(source.replace(marked, ""));
}

async function rgba(svg) {
  const { data, info } = await sharp(svg)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== WIDTH || info.height !== HEIGHT) {
    throw new Error(`wallpaper.svg must be ${WIDTH}x${HEIGHT}`);
  }
  return data;
}

async function wallpaper() {
  const source = await readFile(join(here, "wallpaper.svg"), "utf8");
  const sky = await rgba(part(source, "scene"));
  const scene = await rgba(part(source, "sky"));
  const pixels = WIDTH * HEIGHT;
  const smoothSky = [0, 1, 2].map((channel) => {
    const values = new Float32Array(pixels);
    for (let i = 0; i < pixels; i++) values[i] = sky[i * 4 + channel];
    blur(values, WIDTH, HEIGHT, SKY_BLUR);
    return values;
  });
  // A fixed seed, so the same drawing renders to the same bytes.
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const out = Buffer.alloc(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    const alpha = scene[i * 4 + 3] / 255;
    // The same for all three channels, so the grain is grey rather than coloured speckle.
    const grain = (random() + random() - 1) * GRAIN;
    for (let channel = 0; channel < 3; channel++) {
      const value =
        smoothSky[channel][i] * (1 - alpha) +
        scene[i * 4 + channel] * alpha +
        grain;
      out[i * 3 + channel] = Math.min(255, Math.max(0, Math.round(value)));
    }
  }
  await sharp(out, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
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
