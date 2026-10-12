/**
 * The Chromium command line this computer launches its managed browser with.
 *
 * Playwright-free on purpose: the root CI install deliberately excludes this separately deployed
 * package's dependencies, so a test of the switches (tests/launch-args.test.ts) imports them from
 * here rather than from profiles.ts, which pulls the browser driver in with it.
 */

/**
 * The Chromium features Playwright 1.62.1 switches off on every launch (`chromiumSwitches.ts` in
 * playwright-core, bundled and not importable). Repeated here because Chromium honours only the
 * LAST `--disable-features` switch on its command line: adding one of our own would otherwise throw
 * Playwright's away. Pinned to the `playwright` version in package.json; re-check on upgrade.
 */
export const PLAYWRIGHT_DISABLED_FEATURES = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "BoundaryEventDispatchTracksNodeRemoval",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "BlockOriginHeaderModificationOnRedirect",
  "Translate",
  "AutoDeElevate",
  "OptimizationHints",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
] as const;

/**
 * Playwright's list plus the two Client-Hints restarts.
 *
 * With proxy credentials (the egress filter's, which name the Bot) Playwright intercepts every
 * request to answer the proxy's challenge. Chromium restarts a navigation to add Client Hints when a
 * server asks for them: in the TLS handshake (an ALPS ACCEPT_CH frame, which Google and YouTube
 * send) or with a Critical-CH response header. The restarted request is paused under the same
 * network id, Playwright never continues it, and the page hangs until the navigation timeout —
 * every screenshot of that page hangs with it. Measured on a Fly machine: google.com never loaded;
 * with these two features off it loads in about a second. Client Hints carry nothing a Bot needs.
 */
export const DISABLED_FEATURES = [
  ...PLAYWRIGHT_DISABLED_FEATURES,
  "AcceptCHFrame",
  "CriticalClientHint",
] as const;

/**
 * The switches every launch carries. `sandbox` is whether Chromium keeps its own process sandbox;
 * `localChrome` is a person's own Chrome, which keeps its language, its keychain and its sandbox.
 */
export function launchArgs({
  sandbox,
  localChrome,
}: {
  sandbox: boolean;
  localChrome: boolean;
}): readonly string[] {
  return [
    ...(sandbox ? [] : ["--no-sandbox"]),
    "--disable-dev-shm-usage",
    ...(localChrome ? [] : ["--password-store=basic"]),
    // Drop the automation signals Chromium sets for itself, so a real person who takes the wheel can
    // sign in to a site that refuses obvious automation (Google among them). This is the flag, not a
    // JS patch of `navigator.webdriver`: the flag turns the property off at the source, where
    // spoofing it from a script leaves the other tells a detector cross-checks. It does not change
    // what the Bot may do; the governed path is unchanged. Full Chromium is selected explicitly in
    // both modes; headed mode also provides a window a person can use on the native desktop or
    // virtual display.
    "--disable-blink-features=AutomationControlled",
    `--disable-features=${DISABLED_FEATURES.join(",")}`,
    // English wherever the traffic leaves from: `--lang` for the browser's own words, `--accept-lang`
    // for what it asks every site for (the Accept-Language header and `navigator.languages`,
    // measured on Chromium 145). Google goes by address rather than by this, which is why the start
    // page names `hl=en` (browser-request.ts). Not for a person's own Chrome, whose language is that
    // person's.
    ...(localChrome ? [] : ["--lang=en-US", "--accept-lang=en-US,en"]),
  ];
}

/**
 * How the browser window opens on a desktop, as Chromium switches. Nothing without one.
 *
 * Maximized: the browser is the screen while the Bot is browsing, and the dock, which hides from any
 * window that overlaps it, slides out of the way. Told to Chromium at launch rather than done
 * afterwards, so the first frame a person sees already has it in place.
 */
export function desktopWindowArgs(
  desktop: boolean,
  { gpu = true }: { gpu?: boolean } = {},
): readonly string[] {
  if (!desktop) return [];
  // `COMPUTER_BROWSER_GPU=off`: composite in software in the browser process instead of emulating a
  // GPU, which on a machine with no GPU is the cheaper of two software paths.
  return [
    "--start-maximized",
    // After an unclean exit Chrome offers to restore pages in a bubble over the page, which the Bot
    // cannot read and the person did not ask for; the browser reopens on its start page instead.
    "--hide-crash-restore-bubble",
    ...(gpu ? [] : ["--disable-gpu"]),
  ];
}
