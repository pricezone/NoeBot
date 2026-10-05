import { browserModeFromEnv, type BrowserMode } from "./browser-mode";

export type BrowserRuntime = {
  backend: "managed" | "local-chrome";
  channel: "chromium" | "chrome";
  mode: BrowserMode;
  useVirtualDisplay: boolean;
  /**
   * Whether the computer draws a whole desktop rather than one browser page.
   *
   * `COMPUTER_DESKTOP=on` puts a window manager, a panel and a terminal on the virtual display beside
   * the browser, and the live screen shows the display rather than the page. It implies a headed
   * browser: a headless one has no window to put on a desktop.
   */
  desktop: boolean;
  hostname?: "127.0.0.1";
  allowExec: boolean;
};

/** The same launch decision is used by profiles and the computer HTTP process. */
export function browserRuntimeFromEnv(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): BrowserRuntime {
  const backend = env.COMPUTER_BROWSER_BACKEND?.trim() || "managed";
  if (backend !== "managed" && backend !== "local-chrome") {
    throw new Error(
      "COMPUTER_BROWSER_BACKEND must be managed or local-chrome.",
    );
  }
  const local = backend === "local-chrome";
  const desktop = (env.COMPUTER_DESKTOP?.trim() || "off") === "on";
  if (desktop && local) {
    throw new Error(
      "COMPUTER_DESKTOP=on draws its own desktop on a virtual display, which local Chrome does not use.",
    );
  }
  if (desktop && platform !== "linux") {
    throw new Error(
      "COMPUTER_DESKTOP=on needs the Linux virtual display (Xvfb) the container image provides.",
    );
  }
  const mode = browserModeFromEnv(
    env.COMPUTER_BROWSER_MODE?.trim() ||
      (local || desktop ? "headed" : "headless"),
  );
  if (local && mode !== "headed") {
    throw new Error(
      "COMPUTER_BROWSER_BACKEND=local-chrome requires COMPUTER_BROWSER_MODE=headed.",
    );
  }
  if (desktop && mode !== "headed") {
    throw new Error(
      "COMPUTER_DESKTOP=on requires COMPUTER_BROWSER_MODE=headed, or leave the mode unset.",
    );
  }
  return {
    backend,
    channel: local ? "chrome" : "chromium",
    mode,
    useVirtualDisplay: platform === "linux" && mode === "headed",
    desktop,
    ...(local ? { hostname: "127.0.0.1" as const } : {}),
    allowExec: !local,
  };
}
