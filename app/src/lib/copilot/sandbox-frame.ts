/**
 * The frame a generated interface is drawn in: a document that is always legible, and printing.
 *
 * WHERE THE FRAME IS MADE. Every generated interface — the Bot's own `generateSandboxedUi`, a
 * published component, the gallery and admin previews — is drawn by the SDK's
 * `OpenGenerativeUIActivityRenderer`, and that renderer makes its iframe with one call:
 * `Websandbox.create` from @jetbrains/websandbox, which writes the frame's `sandbox` attribute and its
 * `srcdoc` and only then appends it. The SDK (1.73.1) passes the container, the document and an empty
 * `allow`, and offers no option for either attribute. So this wraps that one call, once, before
 * anything is drawn (provider.tsx). It reaches every surface, the SDK's packaged chat included, which
 * a wrapper component of ours could not; and it acts before the frame navigates, which matters
 * because a `sandbox` attribute changed afterwards only applies to the frame's next navigation.
 *
 * The library is loaded the way the SDK loads it, with a dynamic import, and only in a browser: it
 * reads `window` while it loads, and the tests import the provider with no DOM registered. Requested
 * when the provider's module runs, it settles long before the SDK asks for the same module to draw a
 * frame, and both get the one module, so the class the SDK calls is the class wrapped here.
 *
 * TWO THINGS ARE ADDED, AND NOTHING IS TAKEN AWAY.
 *
 * `allow-modals`, so `window.print()` works. Without it Chromium ignores the call and says so only in
 * the console ("Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword
 * is not set."), which is why a generated document's print button did nothing. The frame keeps its
 * opaque origin: there is still no `allow-same-origin`, so its scripts reach neither this app nor its
 * cookies nor its storage. The keyword would also let `alert`, `confirm` and `prompt` open dialogs
 * over the app, which nobody asked for, so the base document keeps those answering as the sandbox did
 * before: nothing shown, `false`, `null`.
 *
 * A base document, first in <head>. Measured in Chromium: inside the frame `prefers-color-scheme`
 * follows the browser, never the app's theme switch. The app's dark theme puts `color-scheme: dark` on
 * the page, the frame element inherits it, a generated document that declares no scheme is light, and
 * Chromium paints an opaque white backdrop behind a frame whose scheme differs from its element's. A
 * document written to the design guidance (a light palette, then a `prefers-color-scheme: dark`
 * override for its text) therefore drew #fafafa text on that white, and was invisible. Declaring
 * `color-scheme: light dark` makes the canvas, the system colours and the document's own media queries
 * answer from the same preference, and a body default that reads them gives a document that sets no
 * colours of its own text and a background from one scheme. Zero specificity and ahead of the
 * generated stylesheet, so whatever that says wins.
 *
 * Printing is in the light palette. Chromium prints with the screen's `prefers-color-scheme` (measured:
 * a dark screen prints the dark rules) and with background graphics off by default, so a dark-mode
 * document prints its light text on bare paper. For the length of a print the base script switches off
 * every `prefers-color-scheme: dark` rule it can read and pins the scheme to light, then puts both
 * back. A cross-origin stylesheet (a CDN's) cannot be read and is left as it is.
 */
import type Websandbox from "@jetbrains/websandbox";

type Create = typeof Websandbox.create;
type SandboxOptions = NonNullable<Parameters<Create>[1]>;

/** What the frame may do beyond running scripts. Never `allow-same-origin`: see above. */
export const FRAME_PERMISSIONS = ["allow-modals"] as const;

/** Marks the base document, so wrapping twice (a hot reload) does not add it twice. */
const BASE_MARKER = "data-openbot-frame-base";

export const FRAME_BASE_CSS = [
  ":where(:root){color-scheme:light dark}",
  // Canvas first for a browser without light-dark(), which drops the second pair; the second pair is
  // the design guidance's palette (generative-ui.ts), so a bare document still looks like the app.
  ":where(body){background-color:Canvas;color:CanvasText;background-color:light-dark(#ffffff,#0a0a0a);color:light-dark(#0a0a0a,#fafafa)}",
].join("");

/**
 * Runs inside the frame. Plain ES5 in a string rather than a stringified function, so no bundler can
 * rename, transpile or helper-wrap it into something that refers to a scope the frame does not have.
 */
export const FRAME_BASE_SCRIPT = `(function () {
  var dark = /prefers-color-scheme\\s*:\\s*dark/i;
  var root = document.documentElement;
  var parked = [];
  var scheme = null;
  function park(list) {
    if (list && dark.test(list.mediaText)) {
      parked.push([list, list.mediaText]);
      list.mediaText = "not all";
    }
  }
  function walk(rules) {
    for (var i = 0; i < rules.length; i++) {
      park(rules[i].media);
      if (rules[i].cssRules) walk(rules[i].cssRules);
    }
  }
  addEventListener("beforeprint", function () {
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i];
      park(sheet.media);
      try { walk(sheet.cssRules); } catch (e) { /* cross-origin: unreadable */ }
    }
    if (scheme === null) {
      scheme = [root.style.getPropertyValue("color-scheme"), root.style.getPropertyPriority("color-scheme")];
      root.style.setProperty("color-scheme", "light", "important");
    }
  });
  addEventListener("afterprint", function () {
    while (parked.length) { var entry = parked.pop(); entry[0].mediaText = entry[1]; }
    if (scheme !== null) {
      if (scheme[0]) root.style.setProperty("color-scheme", scheme[0], scheme[1]);
      else root.style.removeProperty("color-scheme");
      scheme = null;
    }
  });
  window.alert = function () {};
  window.confirm = function () { return false; };
  window.prompt = function () { return null; };
})();`;

const FRAME_BASE = `<style ${BASE_MARKER}>${FRAME_BASE_CSS}</style><script ${BASE_MARKER}>${FRAME_BASE_SCRIPT}</script>`;

/**
 * The document with the base inserted right after `<head>`, ahead of the generated stylesheet.
 *
 * The literal `<head>` is what websandbox itself requires and inserts its own script after; a
 * document without one is refused by websandbox anyway, so it is returned untouched.
 */
export function withFrameBase(frameContent: string): string {
  if (frameContent.includes(BASE_MARKER) || !frameContent.includes("<head>"))
    return frameContent;
  // A function, not a string: a replacement string would read `$&` and friends in the script.
  return frameContent.replace("<head>", () => `<head>${FRAME_BASE}`);
}

/** The frame's extra sandbox keywords with {@link FRAME_PERMISSIONS} added, each once. */
export function withFramePermissions(existing: string | undefined): string {
  const tokens = new Set((existing ?? "").split(/\s+/).filter(Boolean));
  for (const permission of FRAME_PERMISSIONS) tokens.add(permission);
  return [...tokens].join(" ");
}

/** The options the SDK passed, with the permission and the base document added. */
export function frameOptions(
  options: Partial<SandboxOptions> = {},
): Partial<SandboxOptions> {
  return {
    ...options,
    sandboxAdditionalAttributes: withFramePermissions(
      options.sandboxAdditionalAttributes,
    ),
    // Only a document given inline: one loaded from `frameSrc` is not ours to edit, and websandbox
    // refuses `frameContent` beside it.
    ...(typeof options.frameContent === "string"
      ? { frameContent: withFrameBase(options.frameContent) }
      : {}),
  };
}

type SandboxClass = { create: Create };

const isSandboxClass = (value: unknown): value is SandboxClass =>
  typeof value === "function" &&
  typeof (value as { create?: unknown }).create === "function";

/**
 * The class, through either CommonJS interop: `default.default` when the whole exports object became
 * the default export, `default` when it was unwrapped. The same lookup the SDK makes, so both reach
 * the one class object whichever a bundler chose.
 */
function sandboxClass(module: unknown): SandboxClass | undefined {
  const outer = (module as { default?: unknown } | null)?.default;
  const inner = (outer as { default?: unknown } | null)?.default;
  return [inner, outer].find(isSandboxClass);
}

const wrapped = new WeakSet<SandboxClass>();

/**
 * Wrap `Websandbox.create` so every frame the SDK makes from now on gets {@link frameOptions}.
 * Answers whether the class was found; calling it again changes nothing.
 */
export function installFrameDefaults(module: unknown): boolean {
  const Sandbox = sandboxClass(module);
  if (!Sandbox) return false;
  if (wrapped.has(Sandbox)) return true;
  const create = Sandbox.create;
  Sandbox.create = (localApi, options) =>
    create.call(Sandbox, localApi, frameOptions(options));
  wrapped.add(Sandbox);
  return true;
}

/** Load websandbox, the same module the SDK draws with, and wrap it. Never rejects. */
export function loadFrameDefaults(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return import("@jetbrains/websandbox").then(
    installFrameDefaults,
    () => false,
  );
}
