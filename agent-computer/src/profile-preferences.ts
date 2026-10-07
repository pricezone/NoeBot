/*
 * Chromium profile preferences this computer writes. Free of Playwright, so a test of the rule does
 * not need a browser runtime (the same reason profile-listing.ts is its own module).
 */

/**
 * The preferences this computer sets, merged into whatever the profile already has.
 *
 * WebRTC kept inside the proxy, always (see above). On a desktop, also the Home button and the page
 * it opens, so a person's Home goes where the dock's Chrome button does.
 */
export function withProfilePreferences(
  preferences: Record<string, unknown>,
  { homepage }: { homepage?: string } = {},
): Record<string, unknown> {
  const section = (name: string) =>
    preferences[name] && typeof preferences[name] === "object"
      ? (preferences[name] as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = {
    ...preferences,
    webrtc: {
      ...section("webrtc"),
      ip_handling_policy: "disable_non_proxied_udp",
    },
  };
  if (homepage) {
    next.homepage = homepage;
    next.homepage_is_newtabpage = false;
    next.browser = { ...section("browser"), show_home_button: true };
  }
  return next;
}
