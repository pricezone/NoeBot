import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One throwaway headless launch of the browser at boot, so the first real launch is quick.
 *
 * A machine that has just started has nothing of Chromium in memory, and the first launch spends
 * most of its time reading it from disk: 11.5 s on a Fly instance, against 0.7 s once the files had
 * been read (2026-10-07). Reading the whole installation instead took 26 s there (388 MB at about
 * 15 MB/s) and made a click during it slower still, because most of those bytes are never used. A
 * launch reads exactly what a launch needs, so a hidden one at boot leaves the real one little to do.
 *
 * Throwaway in every sense: its own profile in a temporary directory, deleted after; one line of
 * text rendered from a data: URL; and no network, because every request goes to a proxy that is
 * not there, so nothing it might try (an update check, a field trial) gets past the egress filter.
 *
 * The profile is placed with XDG_CONFIG_HOME, not `--user-data-dir`: given that flag, this Chromium
 * in headless mode never took the screenshot and never exited (measured on the instance; without
 * it, the same run exits in a second). The font cache stays the user's real one, which the image
 * builds, so the warm-up does not build a second one only to delete it.
 */
export function warmUpArgs(profile: string): string[] {
  return [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    // Port 9 is discard; nothing listens there, so every connection is refused at once.
    "--proxy-server=socks5://127.0.0.1:9",
    `--screenshot=${join(profile, "warm.png")}`,
    "--window-size=800,600",
    "data:text/html,<p style='font-family:sans-serif'>Warm</p>",
  ];
}

export function warmUpEnvironment(
  profile: string,
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const home = source.HOME ?? profile;
  return {
    PATH: source.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_CACHE_HOME: source.XDG_CACHE_HOME ?? join(home, ".cache"),
  };
}

export async function warmUpBrowser(
  executable: string,
  { budgetMs = 60_000 }: { budgetMs?: number } = {},
): Promise<{ ms: number; exitCode: number | null; timedOut: boolean }> {
  const started = Date.now();
  const profile = await mkdtemp(join(tmpdir(), "openbot-warmup-"));
  try {
    return await new Promise((resolve) => {
      const child = spawn(executable, warmUpArgs(profile), {
        stdio: "ignore",
        env: warmUpEnvironment(profile, process.env),
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, budgetMs);
      const finish = (exitCode: number | null) => {
        clearTimeout(timer);
        resolve({ ms: Date.now() - started, exitCode, timedOut });
      };
      child.once("error", () => finish(null));
      child.once("exit", (code) => finish(code));
    });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
